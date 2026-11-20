import type { BlacklistEntry, BlacklistKind, OrderRecord } from "../shared/contracts";
import type { AppDatabase } from "./db";
import { AppError, assert } from "./errors";

interface ParsedIp { family: 4 | 6; value: bigint }

function parseIpv4(raw: string): bigint | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

function parseIpv6(raw: string): bigint | null {
  let text = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const embedded = text.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embedded) {
    const v4 = parseIpv4(embedded);
    if (v4 === null) return null;
    text = `${text.slice(0, -embedded.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[\da-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** Parses an IPv4/IPv6 address; IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4. */
export function parseIp(raw: string): ParsedIp | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.includes(":")) {
    const value = parseIpv6(text);
    if (value === null) return null;
    if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  const value = parseIpv4(text);
  return value === null ? null : { family: 4, value };
}

interface IpRule { family: 4 | 6; network: bigint; prefix: number }

/** "1.2.3.4", "1.2.3.0/24", "2408:8000::1", "2408:8000::/64". */
export function parseIpRule(raw: string): IpRule | null {
  const [address = "", prefixText] = raw.trim().split("/");
  const ip = parseIp(address);
  if (!ip) return null;
  const bits = ip.family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < (ip.family === 4 ? 8 : 16) || prefix > bits) return null;
  const shift = BigInt(bits - prefix);
  return { family: ip.family, network: (ip.value >> shift) << shift, prefix };
}

function ruleMatches(rule: IpRule, ip: ParsedIp) {
  if (rule.family !== ip.family) return false;
  const shift = BigInt((rule.family === 4 ? 32 : 128) - rule.prefix);
  return ip.value >> shift === rule.network >> shift;
}

function formatRule(rule: IpRule) {
  if (rule.family === 4) {
    const octets = [24n, 16n, 8n, 0n].map((shift) => String((rule.network >> shift) & 0xffn)).join(".");
    return rule.prefix === 32 ? octets : `${octets}/${rule.prefix}`;
  }
  const groups = Array.from({ length: 8 }, (_, index) => ((rule.network >> BigInt((7 - index) * 16)) & 0xffffn).toString(16));
  // Compress the longest run (≥ 2) of zero groups to "::" (RFC 5952).
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== "0") { index += 1; continue; }
    let end = index;
    while (end < 8 && groups[end] === "0") end += 1;
    if (end - index >= 2 && end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const text = bestStart < 0 ? groups.join(":") : `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLength).join(":")}`;
  return rule.prefix === 128 ? text : `${text}/${rule.prefix}`;
}

/**
 * The rule a one-click block should add for an observed address. IPv6 clients (mobile networks)
 * rotate addresses inside their /64, so blocking the single address would not hold.
 */
export function blockRuleForAddress(address: string) {
  const ip = parseIp(address);
  if (!ip) return null;
  return formatRule(parseIpRule(ip.family === 6 ? `${address.trim()}/64` : address.trim())!);
}

export function normalizeAlipayAccount(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

function normalizeValue(kind: BlacklistKind, raw: string) {
  if (kind === "ip") {
    const rule = parseIpRule(raw);
    assert(rule, 400, "INVALID_IP", "IP 格式错误，支持 1.2.3.4、1.2.3.0/24、IPv6 或 IPv6/64");
    return formatRule(rule);
  }
  const account = normalizeAlipayAccount(raw);
  assert(account.length >= 3 && account.length <= 128, 400, "INVALID_ACCOUNT", "请填写支付宝账号（与账单中显示的一致，例如 **明(138******88)）");
  return account;
}

export function listBlacklist(database: AppDatabase) {
  return database.query("SELECT * FROM blacklist ORDER BY created_at DESC").all() as BlacklistEntry[];
}

/** Adds an entry; adding an existing one just refreshes its note. */
export function addBlacklistEntry(database: AppDatabase, input: { kind: string; value: string; note?: string; createdBy: string }) {
  assert(input.kind === "ip" || input.kind === "alipay_account", 400, "INVALID_KIND", "类型须为 IP 或支付宝账号");
  const kind = input.kind as BlacklistKind;
  const value = normalizeValue(kind, input.value);
  const note = (input.note ?? "").trim().slice(0, 200);
  const existing = database.query("SELECT * FROM blacklist WHERE kind = ? AND value = ?").get(kind, value) as BlacklistEntry | null;
  if (existing) {
    if (note) database.query("UPDATE blacklist SET note = ? WHERE id = ?").run(note, existing.id);
    return { entry: database.query("SELECT * FROM blacklist WHERE id = ?").get(existing.id) as BlacklistEntry, created: false };
  }
  const id = crypto.randomUUID();
  database.query(`
    INSERT INTO blacklist(id, kind, value, note, hits, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(id, kind, value, note, input.createdBy, new Date().toISOString());
  return { entry: database.query("SELECT * FROM blacklist WHERE id = ?").get(id) as BlacklistEntry, created: true };
}

export function removeBlacklistEntry(database: AppDatabase, id: string) {
  const changed = database.query("DELETE FROM blacklist WHERE id = ?").run(id).changes;
  if (!changed) throw new AppError(404, "BLACKLIST_NOT_FOUND", "黑名单记录不存在");
}

function recordHit(database: AppDatabase, entry: BlacklistEntry) {
  database.query("UPDATE blacklist SET hits = hits + 1, last_hit_at = ? WHERE id = ?").run(new Date().toISOString(), entry.id);
}

/** First IP entry matching any of the given addresses, recording the hit. */
export function matchBlockedIp(database: AppDatabase, addresses: Array<string | null | undefined>) {
  const ips = addresses.map((address) => parseIp(address ?? "")).filter((ip): ip is ParsedIp => Boolean(ip));
  if (!ips.length) return null;
  const entries = database.query("SELECT * FROM blacklist WHERE kind = 'ip'").all() as BlacklistEntry[];
  for (const entry of entries) {
    const rule = parseIpRule(entry.value);
    if (rule && ips.some((ip) => ruleMatches(rule, ip))) {
      recordHit(database, entry);
      return entry;
    }
  }
  return null;
}

export function matchBlockedAccount(database: AppDatabase, account: string | null | undefined) {
  const value = normalizeAlipayAccount(account ?? "");
  if (!value) return null;
  const entry = database.query("SELECT * FROM blacklist WHERE kind = 'alipay_account' AND value = ?").get(value) as BlacklistEntry | null;
  if (entry) recordHit(database, entry);
  return entry;
}

export const BLOCKED_MESSAGE = "当前无法为您提供支付服务，请联系商家";

/** Refuses order creation when the buyer's IP is blacklisted. */
export function assertPayerAllowed(database: AppDatabase, addresses: Array<string | null | undefined>) {
  if (matchBlockedIp(database, addresses)) throw new AppError(403, "PAYER_BLOCKED", BLOCKED_MESSAGE);
}

/**
 * Locks an unpaid order for good when its buyer or the current visitor is blacklisted: it is excluded
 * from payment matching and its reserved amount is released. Returns whether the order is blocked.
 */
export function enforceOrderBlock(database: AppDatabase, order: OrderRecord, visitorIp: string) {
  if (order.status === "paid" || order.status === "late_paid") return false;
  if (order.blocked_at) return true;
  if (!matchBlockedIp(database, [order.client_ip, visitorIp])) return false;
  database.query("UPDATE orders SET blocked_at = ? WHERE id = ? AND status IN ('pending', 'expired') AND blocked_at IS NULL")
    .run(new Date().toISOString(), order.id);
  database.query("DELETE FROM amount_reservations WHERE order_id = ?").run(order.id);
  return true;
}
