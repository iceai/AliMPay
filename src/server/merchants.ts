import type { MiddlewareHandler } from "hono";
import type { MerchantStats, MerchantSummary } from "../shared/contracts";
import { authenticateSession, createPasswordHash, type SessionKind } from "./auth";
import type { AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError, assert } from "./errors";
import {
  decryptSecret,
  encryptSecret,
  randomAlphaNumeric,
  randomMerchantPid,
  secureEqual,
  toSpkiPublicKey,
  validatePublicKey,
} from "./security";

export const MERCHANT_SESSION_COOKIE = "alimpay_merchant_session";
export const MERCHANT_CSRF_COOKIE = "alimpay_merchant_csrf";

export interface MerchantRow {
  id: string;
  pid: string;
  name: string;
  username: string | null;
  password_hash: string | null;
  status: "active" | "disabled";
  fee_rate_bp: number;
  v1_key_enc: string;
  v2_public_key: string;
  remark: string;
  created_at: string;
  updated_at: string;
}

export interface MerchantVariables {
  merchant: MerchantRow;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

/** "0.6" (percent, up to 2 decimals) → 60 basis points. */
export function parseFeeRate(value: unknown) {
  const raw = String(value ?? "").trim();
  assert(/^\d{1,3}(\.\d{1,2})?$/.test(raw), 400, "INVALID_FEE_RATE", "手续费须为 0–100 之间、最多两位小数的百分比");
  const [whole, fraction = ""] = raw.split(".");
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  assert(bp >= 0 && bp <= 10_000, 400, "INVALID_FEE_RATE", "手续费须为 0–100 之间、最多两位小数的百分比");
  return bp;
}

export function formatFeeRate(bp: number) {
  return (bp / 100).toFixed(2).replace(/\.?0+$/, "") || "0";
}

/** Fee on the merchant's requested amount, rounded half-up to the cent. */
export function calculateFee(amountCents: number, feeRateBp: number) {
  return Math.round((amountCents * feeRateBp) / 10_000);
}

function masterKey() {
  return getRuntimeEnv().masterKey;
}

export function getMerchantV1Key(merchant: Pick<MerchantRow, "v1_key_enc">) {
  return merchant.v1_key_enc ? decryptSecret(merchant.v1_key_enc, masterKey()) : "";
}

export function maskKey(key: string) {
  return key ? `${key.slice(0, 4)}••••••••${key.slice(-4)}` : "";
}

export function getMerchantByPid(database: AppDatabase, pid: string) {
  if (!pid) return null;
  return database.query("SELECT * FROM merchants WHERE pid = ?").get(pid) as MerchantRow | null;
}

export function getMerchantById(database: AppDatabase, id: string) {
  return database.query("SELECT * FROM merchants WHERE id = ?").get(id) as MerchantRow | null;
}

/** Looks up an API caller by pid and rejects unknown or disabled merchants. */
export function requireActiveMerchant(database: AppDatabase, pid: string) {
  const merchant = getMerchantByPid(database, pid.trim());
  assert(merchant && secureEqual(merchant.pid, pid.trim()), 401, "INVALID_MERCHANT", "商户 ID 错误");
  assert(merchant.status === "active", 403, "MERCHANT_DISABLED", "商户已被禁用");
  return merchant;
}

function shanghaiMidnight(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(Date.now() - daysAgo * 86_400_000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00+08:00`).toISOString();
}

interface PeriodRow { order_count: number; paid_count: number; paid_cents: number; fee_cents: number }

function period(database: AppDatabase, pid: string | undefined, from?: string, to?: string) {
  const where: string[] = [];
  const bindings: string[] = [];
  if (pid) { where.push("pid = ?"); bindings.push(pid); }
  if (from) { where.push("created_at >= ?"); bindings.push(from); }
  if (to) { where.push("created_at < ?"); bindings.push(to); }
  const row = database.query(`
    SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN status IN ('paid','late_paid') THEN 1 ELSE 0 END), 0) AS paid_count,
      COALESCE(SUM(CASE WHEN status IN ('paid','late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS paid_cents,
      COALESCE(SUM(CASE WHEN status IN ('paid','late_paid') THEN fee_cents ELSE 0 END), 0) AS fee_cents
    FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  `).get(...bindings) as PeriodRow;
  return { ...row, net_cents: row.paid_cents - row.fee_cents };
}

/** Order, revenue and fee totals; omit pid for all merchants. Days follow Asia/Shanghai. */
export function merchantStats(database: AppDatabase, pid?: string): MerchantStats {
  const today = shanghaiMidnight(0);
  const yesterday = shanghaiMidnight(1);
  return {
    today: period(database, pid, today),
    yesterday: period(database, pid, yesterday, today),
    last_7_days: period(database, pid, shanghaiMidnight(6)),
    total: period(database, pid),
  };
}

export function serializeMerchant(database: AppDatabase, merchant: MerchantRow, withStats = false): MerchantSummary {
  return {
    id: merchant.id,
    pid: merchant.pid,
    name: merchant.name,
    username: merchant.username,
    login_enabled: Boolean(merchant.username && merchant.password_hash),
    status: merchant.status,
    fee_rate_bp: merchant.fee_rate_bp,
    fee_rate: formatFeeRate(merchant.fee_rate_bp),
    v1_key_masked: maskKey(getMerchantV1Key(merchant)),
    v2_public_key: merchant.v2_public_key,
    remark: merchant.remark,
    created_at: merchant.created_at,
    updated_at: merchant.updated_at,
    ...(withStats ? { stats: merchantStats(database, merchant.pid) } : {}),
  };
}

export function listMerchants(database: AppDatabase) {
  return database.query("SELECT * FROM merchants ORDER BY created_at ASC").all() as MerchantRow[];
}

export function merchantNamesByPid(database: AppDatabase) {
  const rows = database.query("SELECT pid, name FROM merchants").all() as Array<{ pid: string; name: string }>;
  return new Map(rows.map((row) => [row.pid, row.name]));
}

function uniquePid(database: AppDatabase) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pid = randomMerchantPid();
    if (!getMerchantByPid(database, pid)) return pid;
  }
  throw new AppError(500, "PID_GENERATION_FAILED", "无法生成唯一商户 PID，请重试");
}

function assertUsernameFree(database: AppDatabase, username: string, exceptId?: string) {
  assert(USERNAME_PATTERN.test(username), 400, "INVALID_USERNAME", "登录用户名须为 3–32 位字母、数字或 _ . -");
  const taken = database.query("SELECT id FROM merchants WHERE username = ?").get(username) as { id: string } | null;
  assert(!taken || taken.id === exceptId, 409, "USERNAME_TAKEN", "该登录用户名已被其他商户使用");
}

function assertPassword(password: string) {
  assert(password.length >= 8 && password.length <= 128, 400, "INVALID_PASSWORD", "商户密码须为 8–128 位");
}

export interface CreateMerchantInput {
  name: string;
  username?: string | null;
  password?: string | null;
  feeRateBp?: number;
  remark?: string;
  status?: "active" | "disabled";
  /** Fixed credentials for tests; generated when omitted. */
  pid?: string;
  v1Key?: string;
  v2PublicKey?: string;
}

export async function createMerchant(database: AppDatabase, input: CreateMerchantInput) {
  if (input.password) {
    assertPassword(input.password);
    assert(input.username?.trim(), 400, "USERNAME_REQUIRED", "设置登录密码时必须填写登录用户名");
  }
  const passwordHash = input.password ? await createPasswordHash(input.password) : null;
  return insertMerchant(database, input, passwordHash);
}

/** Synchronous core of createMerchant, for callers that already hold a password hash (or none). */
export function insertMerchant(database: AppDatabase, input: CreateMerchantInput, passwordHash: string | null = null) {
  const name = input.name.trim();
  assert(name.length > 0 && name.length <= 64, 400, "INVALID_MERCHANT_NAME", "商户名称不能为空且不超过 64 字");
  const username = input.username?.trim() || null;
  if (username) assertUsernameFree(database, username);
  const feeRateBp = input.feeRateBp ?? 0;
  assert(Number.isInteger(feeRateBp) && feeRateBp >= 0 && feeRateBp <= 10_000, 400, "INVALID_FEE_RATE", "手续费须为 0–100%");
  const pid = input.pid ?? uniquePid(database);
  assert(!getMerchantByPid(database, pid), 409, "PID_TAKEN", "商户 PID 已存在");
  const v1Key = input.v1Key ?? randomAlphaNumeric(32);
  const v2PublicKey = input.v2PublicKey ? toSpkiPublicKey(input.v2PublicKey) : "";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  database.query(`
    INSERT INTO merchants(id, pid, name, username, password_hash, status, fee_rate_bp, v1_key_enc, v2_public_key, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, pid, name, username, passwordHash, input.status ?? "active", feeRateBp,
    encryptSecret(v1Key, masterKey()), v2PublicKey, (input.remark ?? "").trim().slice(0, 500), now, now,
  );
  return { merchant: getMerchantById(database, id)!, v1Key };
}

export async function updateMerchant(database: AppDatabase, id: string, input: {
  name?: string;
  username?: string | null;
  password?: string;
  feeRateBp?: number;
  remark?: string;
  status?: "active" | "disabled";
}) {
  const merchant = getMerchantById(database, id);
  assert(merchant, 404, "MERCHANT_NOT_FOUND", "商户不存在");
  const sets: string[] = [];
  const bindings: Array<string | number | null> = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    assert(name.length > 0 && name.length <= 64, 400, "INVALID_MERCHANT_NAME", "商户名称不能为空且不超过 64 字");
    sets.push("name = ?"); bindings.push(name);
  }
  let username = merchant.username;
  let revokeSessions = false;
  if (input.username !== undefined) {
    username = input.username?.trim() || null;
    if (username) assertUsernameFree(database, username, id);
    sets.push("username = ?"); bindings.push(username);
    if (!username) { sets.push("password_hash = NULL"); }
    if (username !== merchant.username) revokeSessions = true;
  }
  if (input.password) {
    assertPassword(input.password);
    assert(username, 400, "USERNAME_REQUIRED", "设置登录密码时必须填写登录用户名");
    sets.push("password_hash = ?");
    bindings.push(await createPasswordHash(input.password));
    revokeSessions = true;
  }
  if (input.feeRateBp !== undefined) {
    assert(Number.isInteger(input.feeRateBp) && input.feeRateBp >= 0 && input.feeRateBp <= 10_000, 400, "INVALID_FEE_RATE", "手续费须为 0–100%");
    sets.push("fee_rate_bp = ?"); bindings.push(input.feeRateBp);
  }
  if (input.remark !== undefined) { sets.push("remark = ?"); bindings.push(input.remark.trim().slice(0, 500)); }
  if (input.status !== undefined) {
    assert(input.status === "active" || input.status === "disabled", 400, "INVALID_STATUS", "商户状态无效");
    sets.push("status = ?"); bindings.push(input.status);
    if (input.status === "disabled") revokeSessions = true;
  }
  if (sets.length) {
    sets.push("updated_at = ?"); bindings.push(new Date().toISOString());
    database.query(`UPDATE merchants SET ${sets.join(", ")} WHERE id = ?`).run(...bindings, id);
  }
  if (revokeSessions) database.query("DELETE FROM merchant_sessions WHERE merchant_id = ?").run(id);
  return getMerchantById(database, id)!;
}

export function deleteMerchant(database: AppDatabase, id: string) {
  const merchant = getMerchantById(database, id);
  assert(merchant, 404, "MERCHANT_NOT_FOUND", "商户不存在");
  const hasOrders = database.query("SELECT 1 FROM orders WHERE pid = ? LIMIT 1").get(merchant.pid);
  assert(!hasOrders, 409, "MERCHANT_HAS_ORDERS", "该商户已有订单，不能删除，请改为禁用");
  database.query("DELETE FROM merchants WHERE id = ?").run(id);
  return merchant;
}

export function regenerateMerchantV1Key(database: AppDatabase, id: string) {
  const key = randomAlphaNumeric(32);
  const changed = database.query("UPDATE merchants SET v1_key_enc = ?, updated_at = ? WHERE id = ?")
    .run(encryptSecret(key, masterKey()), new Date().toISOString(), id).changes;
  assert(changed, 404, "MERCHANT_NOT_FOUND", "商户不存在");
  return key;
}

export function setMerchantV2PublicKey(database: AppDatabase, id: string, publicKey: string) {
  if (publicKey) validatePublicKey(publicKey);
  const value = publicKey ? toSpkiPublicKey(publicKey) : "";
  const changed = database.query("UPDATE merchants SET v2_public_key = ?, updated_at = ? WHERE id = ?")
    .run(value, new Date().toISOString(), id).changes;
  assert(changed, 404, "MERCHANT_NOT_FOUND", "商户不存在");
  return value;
}

// ---------- Merchant portal sessions ----------

export const MERCHANT_SESSION: SessionKind = {
  table: "merchant_sessions",
  ownerColumn: "merchant_id",
  sessionCookie: MERCHANT_SESSION_COOKIE,
  csrfCookie: MERCHANT_CSRF_COOKIE,
  cookiePath: "/merchant-api",
};

export function merchantAuthMiddleware(database: AppDatabase): MiddlewareHandler<{ Variables: MerchantVariables }> {
  return async (c, next) => {
    const merchant = getMerchantById(database, authenticateSession(c, database, MERCHANT_SESSION));
    if (!merchant) throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
    if (merchant.status !== "active") throw new AppError(403, "MERCHANT_DISABLED", "商户已被禁用");
    c.set("merchant", merchant);
    await next();
  };
}
