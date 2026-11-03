import { getSecret } from "./config";
import { getSetting, type AppDatabase } from "./db";
import { AppError } from "./errors";
import { formatApiDate, getOrderById, getPaymentEvent, suggestOrdersForPayment } from "./orders";
import { centsToMoney } from "./security";

export type AlertKind = "unmatched_payment" | "notify_failed";

interface AlertRow {
  id: string;
  kind: AlertKind;
  ref_id: string;
  attempts: number;
}

const MAX_ALERT_ATTEMPTS = 6;

export function telegramConfig(database: AppDatabase) {
  return {
    enabled: getSetting(database, "telegram_enabled", false),
    chatId: getSetting(database, "telegram_chat_id", ""),
    apiBase: getSetting(database, "telegram_api_base", "https://api.telegram.org").replace(/\/+$/, ""),
    token: getSecret(database, "telegram_bot_token"),
  };
}

export function telegramReady(database: AppDatabase) {
  const config = telegramConfig(database);
  return config.enabled && Boolean(config.chatId && config.token);
}

/** Queues an admin alert once per (kind, ref). Does nothing while Telegram is off, so enabling it later causes no backlog flood. */
export function enqueueAlert(database: AppDatabase, kind: AlertKind, refId: string) {
  if (!telegramReady(database)) return;
  const now = new Date().toISOString();
  database.query(`
    INSERT OR IGNORE INTO admin_alerts(id, kind, ref_id, status, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(crypto.randomUUID(), kind, refId, now, now, now);
}

function adminUrl(database: AppDatabase, path: string) {
  const base = getSetting(database, "public_base_url", "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

/** Returns null when the alert is no longer relevant (already handled). */
export function buildAlertMessage(database: AppDatabase, alert: Pick<AlertRow, "kind" | "ref_id">): string | null {
  if (alert.kind === "unmatched_payment") {
    const event = getPaymentEvent(database, Number(alert.ref_id));
    if (!event || event.matched_order_id || event.ignored_at) return null;
    const lines = [
      "⚠️ 收到一笔未匹配订单的付款",
      `金额：¥${centsToMoney(event.amount_cents)}`,
      `时间：${formatApiDate(event.occurred_at)}`,
    ];
    if (event.other_account) lines.push(`付款方：${event.other_account}`);
    if (event.trans_memo) lines.push(`备注：${event.trans_memo}`);
    const suggestions = suggestOrdersForPayment(database, event, 3);
    if (suggestions.length) {
      lines.push("", "可能对应的订单：");
      for (const order of suggestions) {
        lines.push(`· ${order.name} ¥${centsToMoney(order.payable_amount_cents)}${order.amount_exact ? "（金额一致）" : ""}`);
        lines.push(`  商户单号 ${order.out_trade_no}，创建于 ${formatApiDate(order.created_at)}`);
      }
    } else {
      lines.push("", "没有找到金额相近的未支付订单，可能是与订单无关的收款。");
    }
    lines.push("", `处理：${adminUrl(database, "/payments")}`);
    return lines.join("\n");
  }

  const job = database.query("SELECT order_id, attempts, last_http_status, last_error FROM notification_jobs WHERE id = ?").get(alert.ref_id) as {
    order_id: string; attempts: number; last_http_status: number | null; last_error: string | null;
  } | null;
  if (!job) return null;
  const order = getOrderById(database, job.order_id);
  if (!order) return null;
  const succeededLater = database.query("SELECT 1 FROM notification_jobs WHERE order_id = ? AND status = 'succeeded' LIMIT 1").get(order.id);
  if (succeededLater) return null;
  return [
    "❌ 商户回调通知失败",
    `订单：${order.name} ¥${centsToMoney(order.requested_amount_cents)}`,
    `商户单号：${order.out_trade_no}`,
    `已尝试 ${job.attempts} 次，最后结果：${job.last_http_status ? `HTTP ${job.last_http_status} ` : ""}${job.last_error ?? "未知错误"}`.slice(0, 600),
    "",
    `处理：${adminUrl(database, `/orders/${order.id}`)}`,
  ].join("\n");
}

export async function sendTelegramMessage(database: AppDatabase, text: string, fetcher: typeof fetch = fetch) {
  const config = telegramConfig(database);
  if (!config.token || !config.chatId) throw new AppError(400, "TELEGRAM_NOT_CONFIGURED", "请先填写 Bot Token 和 Chat ID");
  const response = await fetcher(`${config.apiBase}/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !body.ok) {
    throw new AppError(502, "TELEGRAM_SEND_FAILED", `Telegram 发送失败：${body.description ?? `HTTP ${response.status}`}`);
  }
}

export class TelegramAlertWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private working = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      const due = this.database.query(`
        SELECT id, kind, ref_id, attempts FROM admin_alerts
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY created_at ASC LIMIT 10
      `).all(new Date().toISOString()) as AlertRow[];
      for (const alert of due) await this.deliver(alert);
    } finally {
      this.working = false;
    }
  }

  private async deliver(alert: AlertRow) {
    const now = new Date().toISOString();
    const text = buildAlertMessage(this.database, alert);
    if (!text) {
      this.database.query("UPDATE admin_alerts SET status = 'skipped', updated_at = ? WHERE id = ?").run(now, alert.id);
      return;
    }
    try {
      await sendTelegramMessage(this.database, text, this.fetcher);
      this.database.query("UPDATE admin_alerts SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?").run(now, alert.id);
    } catch (error) {
      const attempts = alert.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const next = new Date(Date.now() + Math.min(30, 2 ** attempts) * 60_000).toISOString();
      this.database.query(`
        UPDATE admin_alerts SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?
      `).run(attempts >= MAX_ALERT_ATTEMPTS ? "failed" : "pending", attempts, next, message.slice(0, 500), now, alert.id);
      console.error(JSON.stringify({ level: "error", event: "telegram_alert_failed", alert_id: alert.id, message }));
    }
  }
}
