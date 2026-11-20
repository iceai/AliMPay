import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDatabase } from "./db";
import { getSetting } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError } from "./errors";
import { randomToken, secureEqual, sha256 } from "./security";

export const SESSION_COOKIE = "alimpay_session";
export const CSRF_COOKIE = "alimpay_csrf";

export interface AdminUser {
  id: string;
  username: string;
  created_at: string;
}

export interface AuthVariables {
  admin: AdminUser;
}

interface LoginBucket {
  failures: number[];
  blockedUntil: number;
}

const loginBuckets = new Map<string, LoginBucket>();

export function clientIp(headers: Headers) {
  if (getRuntimeEnv().trustProxy) {
    // Cloudflare overwrites CF-Connecting-IP; the first X-Forwarded-For entry can be supplied by the client.
    return (headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "").trim().slice(0, 128);
  }
  return "";
}

export function setupCompleted(database: AppDatabase) {
  return Boolean(database.query("SELECT 1 FROM admin_users LIMIT 1").get()) && getSetting(database, "setup_completed", false);
}

export function assertOriginAllowed(requestUrl: string, origin: string | undefined, database: AppDatabase) {
  if (!origin) return;
  const allowed = new Set<string>([new URL(requestUrl).origin]);
  try {
    allowed.add(new URL(getSetting(database, "public_base_url", "")).origin);
  } catch {
    // An invalid configured public URL is handled by settings validation.
  }
  if (!allowed.has(origin)) throw new AppError(403, "ORIGIN_REJECTED", "请求来源不受信任");
}

export function checkLoginRateLimit(key: string) {
  const now = Date.now();
  const bucket = loginBuckets.get(key);
  if (bucket?.blockedUntil && bucket.blockedUntil > now) {
    throw new AppError(429, "LOGIN_RATE_LIMITED", "登录尝试过多，请稍后再试");
  }
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const bucket = loginBuckets.get(key) ?? { failures: [], blockedUntil: 0 };
  bucket.failures = bucket.failures.filter((time) => now - time < 15 * 60_000);
  bucket.failures.push(now);
  if (bucket.failures.length >= 5) bucket.blockedUntil = now + 15 * 60_000;
  loginBuckets.set(key, bucket);
}

export function clearLoginFailures(key: string) {
  loginBuckets.delete(key);
}

export async function createPasswordHash(password: string) {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });
}

export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash, "argon2id");
}

let dummyHash: Promise<string> | undefined;

/**
 * Checks a password against an account that may not exist, spending the same argon2 time either way
 * so response timing does not reveal which usernames are valid.
 */
export async function verifyLogin(password: string, hash: string | null | undefined) {
  if (hash) return verifyPassword(password, hash);
  dummyHash ??= createPasswordHash(randomToken(16));
  await verifyPassword(password, await dummyHash);
  return false;
}

export const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{3,32}$/;

/** Idle timeout: a session lives this long after its last use. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** Extend a session (and rewrite its cookie) at most this often. */
const SESSION_RENEW_INTERVAL_MS = 60 * 60_000;
/** Concurrent sessions kept per account, so logging in on another device does not log this one out. */
const MAX_SESSIONS_PER_ACCOUNT = 10;

type CookieContext = Parameters<typeof setCookie>[0];

/**
 * Admin and merchant sessions share this logic but nothing else: separate tables, separate cookie
 * names, and the session cookie is scoped to its own API path so neither is ever sent to the other API.
 */
export interface SessionKind {
  table: "sessions" | "merchant_sessions";
  ownerColumn: "user_id" | "merchant_id";
  sessionCookie: string;
  csrfCookie: string;
  /** The httpOnly session cookie is only sent to this API prefix. */
  cookiePath: string;
}

export const ADMIN_SESSION: SessionKind = {
  table: "sessions",
  ownerColumn: "user_id",
  sessionCookie: SESSION_COOKIE,
  csrfCookie: CSRF_COOKIE,
  cookiePath: "/admin-api",
};

export function issueSession(database: AppDatabase, kind: SessionKind, ownerId: string, headers: Headers) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  database.query(`DELETE FROM ${kind.table} WHERE expires_at <= ?`).run(now.toISOString());
  // Keep the newest sessions only; older devices stay logged in until the cap is reached.
  database.query(`
    DELETE FROM ${kind.table} WHERE ${kind.ownerColumn} = ? AND id NOT IN (
      SELECT id FROM ${kind.table} WHERE ${kind.ownerColumn} = ? ORDER BY last_seen_at DESC LIMIT ?
    )
  `).run(ownerId, ownerId, MAX_SESSIONS_PER_ACCOUNT - 1);
  database.query(`
    INSERT INTO ${kind.table}(id, ${kind.ownerColumn}, token_hash, expires_at, created_at, last_seen_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(), ownerId, sha256(token), expires.toISOString(), now.toISOString(), now.toISOString(),
    clientIp(headers), (headers.get("user-agent") ?? "").slice(0, 512),
  );
  return { token, csrf, expires };
}

export function writeSessionCookies(c: CookieContext, kind: SessionKind, session: { token: string; csrf: string; expires: Date }) {
  const secure = getRuntimeEnv().nodeEnv === "production";
  setCookie(c, kind.sessionCookie, session.token, { httpOnly: true, secure, sameSite: "Strict", path: kind.cookiePath, expires: session.expires });
  // The CSRF cookie must be readable by the page, so it stays on "/" (distinct name per kind).
  setCookie(c, kind.csrfCookie, session.csrf, { httpOnly: false, secure, sameSite: "Strict", path: "/", expires: session.expires });
  // Drop the pre-isolation session cookie that was scoped to "/".
  if (kind.cookiePath !== "/") deleteCookie(c, kind.sessionCookie, { path: "/" });
}

export function clearSessionCookies(c: CookieContext, kind: SessionKind) {
  deleteCookie(c, kind.sessionCookie, { path: kind.cookiePath });
  deleteCookie(c, kind.sessionCookie, { path: "/" });
  deleteCookie(c, kind.csrfCookie, { path: "/" });
}

export function revokeSession(database: AppDatabase, kind: SessionKind, token: string | undefined) {
  if (token) database.query(`DELETE FROM ${kind.table} WHERE token_hash = ?`).run(sha256(token));
}

/** Logs out every other device of this account, e.g. after a password change. */
export function revokeOtherSessions(database: AppDatabase, kind: SessionKind, ownerId: string, keepToken: string | undefined) {
  database.query(`DELETE FROM ${kind.table} WHERE ${kind.ownerColumn} = ? AND token_hash != ?`).run(ownerId, sha256(keepToken ?? ""));
}

/**
 * Validates the session cookie, enforces CSRF + Origin on writes, and slides the expiry forward on use.
 * Returns the owner id, or throws 401.
 */
export function authenticateSession(c: CookieContext, database: AppDatabase, kind: SessionKind) {
  const token = getCookie(c, kind.sessionCookie) ?? "";
  if (!token) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  database.query(`DELETE FROM ${kind.table} WHERE expires_at <= ?`).run(now);
  const row = database.query(`SELECT ${kind.ownerColumn} AS owner_id, expires_at FROM ${kind.table} WHERE token_hash = ? AND expires_at > ?`)
    .get(sha256(token), now) as { owner_id: string; expires_at: string } | null;
  if (!row) throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");

  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    assertOriginAllowed(c.req.url, c.req.header("origin"), database);
    const csrfHeader = c.req.header("x-csrf-token") ?? "";
    const csrfCookie = getCookie(c, kind.csrfCookie) ?? "";
    if (!csrfHeader || !csrfCookie || !secureEqual(csrfHeader, csrfCookie)) {
      throw new AppError(403, "CSRF_REJECTED", "CSRF 校验失败，请刷新页面后重试");
    }
  }

  if (Date.parse(row.expires_at) - nowMs < SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS) {
    const expires = new Date(nowMs + SESSION_TTL_MS);
    database.query(`UPDATE ${kind.table} SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`).run(now, expires.toISOString(), sha256(token));
    writeSessionCookies(c, kind, { token, csrf: getCookie(c, kind.csrfCookie) || randomToken(24), expires });
  } else {
    database.query(`UPDATE ${kind.table} SET last_seen_at = ? WHERE token_hash = ?`).run(now, sha256(token));
  }
  return row.owner_id;
}

export function authMiddleware(database: AppDatabase): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const userId = authenticateSession(c, database, ADMIN_SESSION);
    const user = database.query("SELECT id, username, created_at FROM admin_users WHERE id = ?").get(userId) as AdminUser | null;
    if (!user) throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
    c.set("admin", user);
    await next();
  };
}
