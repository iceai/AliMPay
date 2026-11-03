import { afterEach, describe, expect, it, mock } from "bun:test";
import { setSecret } from "../src/server/config";
import { setSetting, type AppDatabase } from "../src/server/db";
import { NotificationWorker } from "../src/server/notifications";
import {
  candidatePaymentsForOrder,
  countUnmatchedPayments,
  createOrder,
  getOrderById,
  ignoreAllUnmatchedPayments,
  linkPaymentToOrder,
  recordAndMatchPayment,
  setPaymentIgnored,
  suggestOrdersForPayment,
} from "../src/server/orders";
import { TelegramAlertWorker, buildAlertMessage, enqueueAlert } from "../src/server/telegram";
import { configuredDatabase, orderInput } from "./helpers";

let database: AppDatabase | undefined;
afterEach(() => database?.close());

function expireOrder(db: AppDatabase, id: string, minutesAgo = 30) {
  const created = Date.now() - minutesAgo * 60_000;
  db.query("UPDATE orders SET created_at = ?, expires_at = ?, monitor_until = ?, status = 'expired' WHERE id = ?").run(
    new Date(created).toISOString(), new Date(created + 5 * 60_000).toISOString(), new Date(created + 10 * 60_000).toISOString(), id,
  );
}

function recordIncome(db: AppDatabase, id: string, amount: number, memo = "") {
  const result = recordAndMatchPayment(db, {
    accountLogId: id, occurredAt: new Date().toISOString(), direction: "收入", amountCents: amount,
    alipayOrderNo: `ALI-${id}`, transMemo: memo, otherAccount: "buyer@example.com", raw: {},
  }, []);
  return result.eventId!;
}

function enableTelegram(db: AppDatabase) {
  setSetting(db, "telegram_enabled", true);
  setSetting(db, "telegram_chat_id", "123456");
  setSecret(db, "telegram_bot_token", "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
}

describe("unmatched payments and manual linking", () => {
  it("suggests the expired order for a late payment and links it with a notification", () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    expireOrder(database, order.id);
    const eventId = recordIncome(database, "LATE-1", order.payable_amount_cents);

    expect(countUnmatchedPayments(database)).toBe(1);
    const event = database.query("SELECT * FROM payment_events WHERE id = ?").get(eventId) as { occurred_at: string; amount_cents: number; trans_memo: string | null };
    expect(suggestOrdersForPayment(database, event)[0]?.id).toBe(order.id);
    expect(candidatePaymentsForOrder(database, getOrderById(database, order.id)!)[0]?.id).toBe(eventId);

    const result = linkPaymentToOrder(database, eventId, order.id);
    expect(result.order.status).toBe("late_paid");
    expect(result.order.alipay_account_log_id).toBe("LATE-1");
    expect(result.amountMismatch).toBe(false);
    expect(countUnmatchedPayments(database)).toBe(0);
    const job = database.query("SELECT status, manual FROM notification_jobs WHERE order_id = ?").get(order.id) as { status: string; manual: number };
    expect(job).toEqual({ status: "pending", manual: 0 });
    expect(database.query("SELECT 1 FROM amount_reservations WHERE order_id = ?").get(order.id)).toBeNull();
  });

  it("allows linking a payment with the wrong amount and reports the mismatch", () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    expireOrder(database, order.id);
    const eventId = recordIncome(database, "WRONG-1", order.payable_amount_cents - 1);
    expect(linkPaymentToOrder(database, eventId, order.id).amountMismatch).toBe(true);
  });

  it("refuses double linking and linking to a paid order", () => {
    ({ database } = configuredDatabase());
    const first = createOrder(database, orderInput(1)).order;
    const second = createOrder(database, orderInput(2)).order;
    expireOrder(database, first.id);
    expireOrder(database, second.id);
    const eventA = recordIncome(database, "A", 100);
    const eventB = recordIncome(database, "B", 101);
    linkPaymentToOrder(database, eventA, first.id);
    expect(() => linkPaymentToOrder(database!, eventA, second.id)).toThrow("已经关联");
    expect(() => linkPaymentToOrder(database!, eventB, first.id)).toThrow("支付成功");
  });

  it("hides ignored payments from the unmatched count", () => {
    ({ database } = configuredDatabase());
    const eventId = recordIncome(database, "GIFT", 8_800);
    setPaymentIgnored(database, eventId, true);
    expect(countUnmatchedPayments(database)).toBe(0);
    setPaymentIgnored(database, eventId, false);
    expect(countUnmatchedPayments(database)).toBe(1);
  });

  it("ignores every pending unmatched payment at once but keeps linked ones", () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    expireOrder(database, order.id);
    const linked = recordIncome(database, "LINKED", order.payable_amount_cents);
    linkPaymentToOrder(database, linked, order.id);
    recordIncome(database, "OLD-1", 500);
    recordIncome(database, "OLD-2", 600);
    expect(ignoreAllUnmatchedPayments(database)).toBe(2);
    expect(countUnmatchedPayments(database)).toBe(0);
    expect(database.query("SELECT ignored_at FROM payment_events WHERE account_log_id = 'LINKED'").get()).toEqual({ ignored_at: null });
  });
});

describe("telegram alerts", () => {
  it("queues nothing while telegram is disabled", () => {
    ({ database } = configuredDatabase());
    enqueueAlert(database, "unmatched_payment", "1");
    expect(database.query("SELECT COUNT(*) AS count FROM admin_alerts").get()).toEqual({ count: 0 });
  });

  it("sends an unmatched-payment alert once and skips it after the payment is linked", async () => {
    ({ database } = configuredDatabase());
    enableTelegram(database);
    const order = createOrder(database, orderInput(1)).order;
    expireOrder(database, order.id);
    const eventId = recordIncome(database, "TG-1", order.payable_amount_cents);
    enqueueAlert(database, "unmatched_payment", String(eventId));
    enqueueAlert(database, "unmatched_payment", String(eventId));

    const message = buildAlertMessage(database, { kind: "unmatched_payment", ref_id: String(eventId) })!;
    expect(message).toContain("¥1.00");
    expect(message).toContain(order.out_trade_no);

    const sent: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    await new TelegramAlertWorker(database, fetcher).tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage");
    expect(sent[0]!.body.chat_id).toBe("123456");

    linkPaymentToOrder(database, eventId, order.id);
    expect(buildAlertMessage(database, { kind: "unmatched_payment", ref_id: String(eventId) })).toBeNull();
  });

  it("retries a failed telegram send later", async () => {
    ({ database } = configuredDatabase());
    enableTelegram(database);
    const eventId = recordIncome(database, "TG-2", 500);
    enqueueAlert(database, "unmatched_payment", String(eventId));
    const fetcher = mock(async () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 })) as unknown as typeof fetch;
    await new TelegramAlertWorker(database, fetcher).tick();
    const alert = database.query("SELECT status, attempts, last_error FROM admin_alerts").get() as { status: string; attempts: number; last_error: string };
    expect(alert.status).toBe("pending");
    expect(alert.attempts).toBe(1);
    expect(alert.last_error).toContain("Unauthorized");
  });

  it("alerts when an automatic merchant notification exhausts its retries", async () => {
    ({ database } = configuredDatabase());
    enableTelegram(database);
    const order = createOrder(database, orderInput(1)).order;
    const now = new Date().toISOString();
    database.query("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(now, order.id);
    database.query(`
      INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
      VALUES ('job-1', ?, 'pending', 0, 1, ?, 0, ?, ?)
    `).run(order.id, now, now, now);
    const fetcher = mock(async () => new Response("fail", { status: 500 })) as unknown as typeof fetch;
    await new NotificationWorker(database, fetcher).tick();
    const alert = database.query("SELECT kind, ref_id FROM admin_alerts").get();
    expect(alert).toEqual({ kind: "notify_failed", ref_id: "job-1" });
    expect(buildAlertMessage(database, { kind: "notify_failed", ref_id: "job-1" })).toContain("HTTP 500");
  });
});
