import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { OrderStatus } from "../shared/contracts";
import {
  assertOriginAllowed,
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
  verifyPassword,
} from "./auth";
import { audit, getSetting, type AppDatabase } from "./db";
import { AppError, assert } from "./errors";
import {
  MERCHANT_SESSION_COOKIE,
  clearMerchantCookies,
  createMerchantSession,
  getMerchantById,
  getMerchantV1Key,
  merchantAuthMiddleware,
  merchantStats,
  regenerateMerchantV1Key,
  serializeMerchant,
  setMerchantCookies,
  setMerchantV2PublicKey,
  updateMerchant,
  type MerchantRow,
  type MerchantVariables,
} from "./merchants";
import { getOrderById, listOrders } from "./orders";
import { generateRsaKeyPair, sha256 } from "./security";
import {
  WITHDRAWAL_STATUSES,
  cancelWithdrawal,
  getMerchantBalance,
  getWithdrawalSettings,
  lastWithdrawalAccount,
  listWithdrawals,
  maxWithdrawable,
  requestWithdrawal,
} from "./withdrawals";
import type { WithdrawalStatus } from "../shared/contracts";

const loginSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(128),
});

/** Order fields a merchant may see: no checkout token, raw request or internal ids of other systems. */
function merchantOrderView(order: NonNullable<ReturnType<typeof getOrderById>>) {
  return {
    id: order.id,
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    api_version: order.api_version,
    name: order.name,
    requested_amount_cents: order.requested_amount_cents,
    payable_amount_cents: order.payable_amount_cents,
    fee_rate_bp: order.fee_rate_bp,
    fee_cents: order.fee_cents,
    status: order.status,
    notify_url: order.notify_url,
    return_url: order.return_url,
    param: order.param,
    client_ip: order.client_ip,
    buyer: order.buyer,
    alipay_order_no: order.alipay_order_no,
    created_at: order.created_at,
    expires_at: order.expires_at,
    paid_at: order.paid_at,
  };
}

function notificationSummary(database: AppDatabase, orderId: string) {
  return database.query(`
    SELECT id, status, attempts, max_attempts, last_http_status, last_error, manual, created_at, updated_at
    FROM notification_jobs WHERE order_id = ? ORDER BY created_at DESC
  `).all(orderId);
}

export function createMerchantPortalRoutes(database: AppDatabase) {
  const app = new Hono<{ Variables: MerchantVariables }>();

  app.post("/login", async (c) => {
    assertOriginAllowed(c.req.url, c.req.header("origin"), database);
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(400, "INVALID_LOGIN", "用户名或密码格式错误");
    const rateKey = `merchant:${clientIp(c.req.raw.headers)}:${parsed.data.username}`;
    checkLoginRateLimit(rateKey);
    const merchant = database.query("SELECT * FROM merchants WHERE username = ?").get(parsed.data.username) as MerchantRow | null;
    if (!merchant?.password_hash || !(await verifyPassword(parsed.data.password, merchant.password_hash))) {
      recordLoginFailure(rateKey);
      audit(database, "merchant.login_failed", { actor: `merchant:${parsed.data.username}`, ip: clientIp(c.req.raw.headers) });
      throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码错误");
    }
    assert(merchant.status === "active", 403, "MERCHANT_DISABLED", "商户已被禁用，请联系平台管理员");
    clearLoginFailures(rateKey);
    database.query("DELETE FROM merchant_sessions WHERE merchant_id = ?").run(merchant.id);
    setMerchantCookies(c, createMerchantSession(database, merchant.id, c.req.raw.headers));
    audit(database, "merchant.login", { actor: `merchant:${merchant.username}`, targetType: "merchant", targetId: merchant.id, ip: clientIp(c.req.raw.headers) });
    return c.json({ ok: true, name: merchant.name });
  });

  app.use("*", merchantAuthMiddleware(database));

  app.get("/me", (c) => c.json({ merchant: serializeMerchant(database, c.get("merchant")) }));

  app.post("/logout", (c) => {
    const token = getCookie(c, MERCHANT_SESSION_COOKIE);
    if (token) database.query("DELETE FROM merchant_sessions WHERE token_hash = ?").run(sha256(token));
    clearMerchantCookies(c);
    return c.json({ ok: true });
  });

  app.get("/dashboard", (c) => {
    const merchant = c.get("merchant");
    return c.json({
      merchant: serializeMerchant(database, merchant),
      stats: merchantStats(database, merchant.pid),
      balance: getMerchantBalance(database, merchant),
      recent_orders: listOrders(database, { pid: merchant.pid, limit: 8 }).data.map(merchantOrderView),
    });
  });

  app.get("/orders", (c) => {
    const status = c.req.query("status") as OrderStatus | undefined;
    if (status && !["pending", "expired", "paid", "late_paid"].includes(status)) {
      throw new AppError(400, "INVALID_STATUS", "订单状态筛选值无效");
    }
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    const result = listOrders(database, {
      pid: c.get("merchant").pid,
      status,
      query: c.req.query("q")?.trim(),
      limit,
      offset: (page - 1) * limit,
    });
    return c.json({ ...result, data: result.data.map(merchantOrderView), page });
  });

  app.get("/orders/:id", (c) => {
    const order = getOrderById(database, c.req.param("id"));
    // Treat other merchants' orders as nonexistent so ids cannot be probed.
    assert(order && order.pid === c.get("merchant").pid, 404, "ORDER_NOT_FOUND", "订单不存在");
    return c.json({ order: merchantOrderView(order), notifications: notificationSummary(database, order.id) });
  });

  app.get("/keys", (c) => {
    const merchant = c.get("merchant");
    return c.json({
      ...serializeMerchant(database, merchant),
      platform_public_key: getSetting(database, "v2_platform_public_key", ""),
      base_url: getSetting(database, "public_base_url", "").replace(/\/$/, ""),
      v1_enabled: getSetting(database, "v1_enabled", true),
      v2_enabled: getSetting(database, "v2_enabled", true),
    });
  });

  app.post("/keys/v1/reveal", (c) => {
    const merchant = c.get("merchant");
    return c.json({ pid: merchant.pid, key: getMerchantV1Key(merchant) });
  });

  app.post("/keys/v1/regenerate", (c) => {
    const merchant = c.get("merchant");
    const key = regenerateMerchantV1Key(database, merchant.id);
    audit(database, "merchant.v1_regenerate", { actor: `merchant:${merchant.username}`, targetType: "merchant", targetId: merchant.id });
    return c.json({ pid: merchant.pid, key });
  });

  app.post("/keys/v2/generate", (c) => {
    const merchant = c.get("merchant");
    const pair = generateRsaKeyPair();
    setMerchantV2PublicKey(database, merchant.id, pair.publicKey);
    audit(database, "merchant.v2_generate", { actor: `merchant:${merchant.username}`, targetType: "merchant", targetId: merchant.id });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey, one_time: true });
  });

  app.put("/keys/v2", async (c) => {
    const merchant = c.get("merchant");
    const body = await c.req.json<{ public_key?: string }>().catch(() => ({} as { public_key?: string }));
    const publicKey = body.public_key?.trim() ?? "";
    assert(publicKey, 400, "PUBLIC_KEY_REQUIRED", "商户公钥不能为空");
    setMerchantV2PublicKey(database, merchant.id, publicKey);
    audit(database, "merchant.v2_import", { actor: `merchant:${merchant.username}`, targetType: "merchant", targetId: merchant.id });
    return c.json({ ok: true });
  });

  app.get("/withdrawals", (c) => {
    const merchant = c.get("merchant");
    const status = c.req.query("status") as WithdrawalStatus | undefined;
    assert(!status || WITHDRAWAL_STATUSES.includes(status), 400, "INVALID_STATUS", "状态筛选值无效");
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const settings = getWithdrawalSettings(database);
    const balance = getMerchantBalance(database, merchant);
    const result = listWithdrawals(database, { merchantId: merchant.id, status, limit: 20, offset: (page - 1) * 20 });
    return c.json({
      ...result,
      page,
      balance,
      settings,
      max_amount_cents: maxWithdrawable(balance.available_cents, settings.fee_rate_bp),
      last_account: lastWithdrawalAccount(database, merchant.id),
    });
  });

  app.post("/withdrawals", async (c) => {
    const merchant = c.get("merchant");
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const text = (key: string) => (typeof body[key] === "string" || typeof body[key] === "number" ? String(body[key]) : "");
    const withdrawal = requestWithdrawal(database, merchant, {
      amount: text("amount"),
      accountType: text("account_type"),
      accountNo: text("account_no"),
      accountName: text("account_name"),
      bankName: text("bank_name"),
      note: text("note"),
    });
    audit(database, "withdrawal.request", {
      actor: `merchant:${merchant.username}`, targetType: "withdrawal", targetId: withdrawal.id, ip: clientIp(c.req.raw.headers),
      details: { withdraw_no: withdrawal.withdraw_no, amount_cents: withdrawal.amount_cents, fee_cents: withdrawal.fee_cents },
    });
    return c.json({ ok: true, withdrawal, balance: getMerchantBalance(database, merchant) }, 201);
  });

  app.post("/withdrawals/:id/cancel", (c) => {
    const merchant = c.get("merchant");
    const withdrawal = cancelWithdrawal(database, c.req.param("id"), merchant.id);
    audit(database, "withdrawal.cancel", { actor: `merchant:${merchant.username}`, targetType: "withdrawal", targetId: withdrawal.id });
    return c.json({ ok: true, withdrawal, balance: getMerchantBalance(database, merchant) });
  });

  app.put("/password", async (c) => {
    const body = await c.req.json<{ current_password?: string; new_password?: string }>().catch(() => ({} as Record<string, string>));
    assert(body.current_password && body.new_password, 400, "PASSWORD_REQUIRED", "当前密码和新密码不能为空");
    const merchant = getMerchantById(database, c.get("merchant").id)!;
    assert(merchant.password_hash && await verifyPassword(body.current_password, merchant.password_hash), 401, "INVALID_PASSWORD", "当前密码错误");
    await updateMerchant(database, merchant.id, { password: body.new_password });
    // updateMerchant revokes every session; start a fresh one for this browser.
    setMerchantCookies(c, createMerchantSession(database, merchant.id, c.req.raw.headers));
    audit(database, "merchant.password_change", { actor: `merchant:${merchant.username}`, targetType: "merchant", targetId: merchant.id });
    return c.json({ ok: true });
  });

  return app;
}
