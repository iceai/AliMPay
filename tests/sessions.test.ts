import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import { createPasswordHash, SESSION_TTL_MS } from "../src/server/auth";
import type { AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { createMerchant } from "../src/server/merchants";
import { NotificationWorker } from "../src/server/notifications";
import { configuredDatabase } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

const ORIGIN = { origin: "http://localhost", "content-type": "application/json" };

async function setup() {
  ({ database } = configuredDatabase());
  const db = database;
  const now = new Date().toISOString();
  db.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)")
    .run(crypto.randomUUID(), await createPasswordHash("admin-password-123"), now, now);
  await createMerchant(db, { name: "Shop", username: "shop", password: "shop-password" });
  const { app } = createApp({ database: db, scanner: new PaymentScanner(db, new EmptyProvider()), notifications: new NotificationWorker(db, fetch) });
  return { db, app };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

async function login(app: App, area: "admin" | "merchant", password: string) {
  const response = await app.request(`http://localhost/${area}-api/login`, {
    method: "POST", headers: ORIGIN,
    body: JSON.stringify({ username: area === "admin" ? "admin" : "shop", password }),
  });
  expect(response.status).toBe(200);
  const setCookies = response.headers.getSetCookie();
  const pairs = setCookies.filter((value) => !/Max-Age=0/i.test(value)).map((value) => value.split(";")[0]!);
  const csrfName = area === "admin" ? "alimpay_csrf" : "alimpay_merchant_csrf";
  return {
    setCookies,
    cookie: pairs.join("; "),
    headers: { ...ORIGIN, cookie: pairs.join("; "), "x-csrf-token": pairs.find((pair) => pair.startsWith(`${csrfName}=`))!.split("=")[1]! },
  };
}

describe("sessions", () => {
  it("scopes each area's session cookie to its own API path", async () => {
    const { app } = await setup();
    const admin = await login(app, "admin", "admin-password-123");
    const sessionCookie = admin.setCookies.find((value) => value.startsWith("alimpay_session=") && !/Max-Age=0/i.test(value))!;
    expect(sessionCookie).toContain("Path=/admin-api");
    expect(sessionCookie).toContain("HttpOnly");
    // The legacy cookie on "/" is cleared so it can't shadow the scoped one.
    expect(admin.setCookies.some((value) => value.startsWith("alimpay_session=") && /Path=\/(;|$)/.test(value) && /Max-Age=0/i.test(value))).toBe(true);
    expect(admin.setCookies.find((value) => value.startsWith("alimpay_csrf="))).toContain("Path=/");

    const merchant = await login(app, "merchant", "shop-password");
    expect(merchant.setCookies.find((value) => value.startsWith("alimpay_merchant_session=") && !/Max-Age=0/i.test(value))).toContain("Path=/merchant-api");

    // Each session only opens its own area.
    expect((await app.request("http://localhost/admin-api/me", { headers: { cookie: merchant.cookie } })).status).toBe(401);
    expect((await app.request("http://localhost/merchant-api/me", { headers: { cookie: admin.cookie } })).status).toBe(401);
  });

  it("keeps earlier devices logged in when logging in again", async () => {
    const { app } = await setup();
    const laptop = await login(app, "admin", "admin-password-123");
    const phone = await login(app, "admin", "admin-password-123");
    expect((await app.request("http://localhost/admin-api/me", { headers: { cookie: laptop.cookie } })).status).toBe(200);
    expect((await app.request("http://localhost/admin-api/me", { headers: { cookie: phone.cookie } })).status).toBe(200);

    const shopA = await login(app, "merchant", "shop-password");
    const shopB = await login(app, "merchant", "shop-password");
    expect((await app.request("http://localhost/merchant-api/me", { headers: { cookie: shopA.cookie } })).status).toBe(200);
    expect((await app.request("http://localhost/merchant-api/me", { headers: { cookie: shopB.cookie } })).status).toBe(200);
  });

  it("slides the expiry forward while the session is in use", async () => {
    const { db, app } = await setup();
    const admin = await login(app, "admin", "admin-password-123");
    // Pretend the session was last renewed 3 days ago.
    const aged = new Date(Date.now() + SESSION_TTL_MS - 3 * 86_400_000).toISOString();
    db.query("UPDATE sessions SET expires_at = ?").run(aged);
    const response = await app.request("http://localhost/admin-api/me", { headers: { cookie: admin.cookie } });
    expect(response.status).toBe(200);
    const renewed = (db.query("SELECT expires_at FROM sessions").get() as { expires_at: string }).expires_at;
    expect(Date.parse(renewed) - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
    expect(response.headers.getSetCookie().some((value) => value.startsWith("alimpay_session=") && value.includes("Path=/admin-api"))).toBe(true);

    // A fresh session is not rewritten on every request.
    const quiet = await app.request("http://localhost/admin-api/me", { headers: { cookie: admin.cookie } });
    expect(quiet.headers.getSetCookie()).toHaveLength(0);
  });

  it("expires sessions idle for longer than the TTL", async () => {
    const { db, app } = await setup();
    const admin = await login(app, "admin", "admin-password-123");
    db.query("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1_000).toISOString());
    expect((await app.request("http://localhost/admin-api/me", { headers: { cookie: admin.cookie } })).status).toBe(401);
  });

  it("logs out other devices after an admin password change", async () => {
    const { app } = await setup();
    const laptop = await login(app, "admin", "admin-password-123");
    const phone = await login(app, "admin", "admin-password-123");
    const changed = await app.request("http://localhost/admin-api/password", {
      method: "PUT", headers: laptop.headers,
      body: JSON.stringify({ current_password: "admin-password-123", new_password: "new-admin-password-456" }),
    });
    expect(changed.status).toBe(200);
    expect((await app.request("http://localhost/admin-api/me", { headers: { cookie: laptop.cookie } })).status).toBe(200);
    expect((await app.request("http://localhost/admin-api/me", { headers: { cookie: phone.cookie } })).status).toBe(401);
  });
});

describe("admin username", () => {
  it("requires the username and gives the same answer for a wrong username or password", async () => {
    const { app } = await setup();
    const attempt = (body: Record<string, string>) => app.request("http://localhost/admin-api/login", { method: "POST", headers: ORIGIN, body: JSON.stringify(body) });
    expect((await attempt({ password: "admin-password-123" })).status).toBe(400);
    const wrongUser = await attempt({ username: "root", password: "admin-password-123" });
    const wrongPassword = await attempt({ username: "admin", password: "nope-nope-nope" });
    expect(wrongUser.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await wrongUser.json()).toEqual(await wrongPassword.json());
    const ok = await attempt({ username: "admin", password: "admin-password-123" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain("admin");
  });

  it("lets the admin rename the account", async () => {
    const { app } = await setup();
    const admin = await login(app, "admin", "admin-password-123");
    const rename = (username: string, current_password: string) => app.request("http://localhost/admin-api/account", {
      method: "PUT", headers: admin.headers, body: JSON.stringify({ username, current_password }),
    });
    expect((await rename("ops-owner", "wrong-password")).status).toBe(401);
    expect((await rename("x", "admin-password-123")).status).toBe(400);
    expect((await rename("ops-owner", "admin-password-123")).status).toBe(200);
    const me = await (await app.request("http://localhost/admin-api/me", { headers: { cookie: admin.cookie } })).json() as { user: { username: string } };
    expect(me.user.username).toBe("ops-owner");
    const old = await app.request("http://localhost/admin-api/login", { method: "POST", headers: ORIGIN, body: JSON.stringify({ username: "admin", password: "admin-password-123" }) });
    expect(old.status).toBe(401);
    const renamed = await app.request("http://localhost/admin-api/login", { method: "POST", headers: ORIGIN, body: JSON.stringify({ username: "ops-owner", password: "admin-password-123" }) });
    expect(renamed.status).toBe(200);
  });
});
