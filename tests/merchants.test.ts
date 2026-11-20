import { afterEach, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import { setSecret } from "../src/server/config";
import { createDatabase, setSetting, type AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import {
  calculateFee,
  createMerchant,
  formatFeeRate,
  getMerchantByPid,
  getMerchantV1Key,
  parseFeeRate,
} from "../src/server/merchants";
import { NotificationWorker } from "../src/server/notifications";
import { createOrder, getOrderById, recordAndMatchPayment, getActiveOrders } from "../src/server/orders";
import { md5Sign, sha256, verifyMd5 } from "../src/server/security";
import { configuredDatabase, orderInput } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

function appFor(db: AppDatabase) {
  return createApp({ database: db, scanner: new PaymentScanner(db, new EmptyProvider()), notifications: new NotificationWorker(db, fetch) }).app;
}

function adminHeaders(db: AppDatabase) {
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  db.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', 'unused', ?, ?)").run(userId, now, now);
  db.query(`
    INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, sha256("admin-token"), new Date(Date.now() + 60_000).toISOString(), now, now);
  return {
    cookie: "alimpay_session=admin-token; alimpay_csrf=admin-csrf",
    "x-csrf-token": "admin-csrf",
    origin: "http://localhost",
    "content-type": "application/json",
  };
}

function v1Order(pid: string, key: string, outTradeNo: string, money = "100.00") {
  const unsigned = {
    pid, type: "alipay", out_trade_no: outTradeNo, notify_url: "https://merchant.example/notify",
    name: "Item", money, clientip: "203.0.113.10", sign_type: "MD5",
  };
  return new URLSearchParams({ ...unsigned, sign: md5Sign(unsigned, key) }).toString();
}

const formHeaders = { "content-type": "application/x-www-form-urlencoded" };

describe("fee rates", () => {
  it("parses percent strings into basis points and rounds fees to the cent", () => {
    expect(parseFeeRate("0.6")).toBe(60);
    expect(parseFeeRate("3")).toBe(300);
    expect(parseFeeRate("100")).toBe(10_000);
    expect(() => parseFeeRate("100.01")).toThrow();
    expect(() => parseFeeRate("0.001")).toThrow();
    expect(() => parseFeeRate("-1")).toThrow();
    expect(formatFeeRate(60)).toBe("0.6");
    expect(formatFeeRate(0)).toBe("0");
    expect(formatFeeRate(250)).toBe("2.5");
    expect(calculateFee(10_000, 60)).toBe(60);
    expect(calculateFee(199, 60)).toBe(1); // 1.194 → 1
    expect(calculateFee(250, 60)).toBe(2); // 1.5 → 2
  });

  it("snapshots the merchant rate on each order", () => {
    ({ database } = configuredDatabase());
    database.query("UPDATE merchants SET fee_rate_bp = 250 WHERE pid = '1000000001'").run();
    const first = createOrder(database, { ...orderInput(1), money: "10.00" }).order;
    expect(first.fee_rate_bp).toBe(250);
    expect(first.fee_cents).toBe(25);
    database.query("UPDATE merchants SET fee_rate_bp = 0 WHERE pid = '1000000001'").run();
    expect(getOrderById(database, first.id)?.fee_cents).toBe(25);
    expect(createOrder(database, { ...orderInput(2), money: "10.00" }).order.fee_cents).toBe(0);
  });
});

describe("admin merchant management", () => {
  it("creates merchants with independent API keys and fee rates", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const headers = adminHeaders(database);

    const created = await app.request("http://localhost/admin-api/merchants", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Shop B", username: "shopb", password: "shop-b-password", fee_rate: "1.5" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { pid: string; key: string; merchant: { fee_rate_bp: number; login_enabled: boolean } };
    expect(body.pid).toMatch(/^\d{10}$/);
    expect(body.key).toHaveLength(32);
    expect(body.merchant.fee_rate_bp).toBe(150);
    expect(body.merchant.login_enabled).toBe(true);

    // Merchant B's key works for B only.
    const ok = await app.request("http://localhost/mapi.php", { method: "POST", headers: formHeaders, body: v1Order(body.pid, body.key, "B-1") });
    expect((await ok.json() as { code: number }).code).toBe(1);
    const order = database.query("SELECT * FROM orders WHERE out_trade_no = 'B-1'").get() as { pid: string; fee_cents: number };
    expect(order.pid).toBe(body.pid);
    expect(order.fee_cents).toBe(150);
    const crossed = await app.request("http://localhost/mapi.php", { method: "POST", headers: formHeaders, body: v1Order("1000000001", body.key, "A-1") });
    expect((await crossed.json() as { code: number; msg: string }).code).toBe(-1);

    // Listing includes stats and never leaks the raw key.
    const listText = await (await app.request("http://localhost/admin-api/merchants", { headers })).text();
    expect(listText).not.toContain(body.key);
    const list = JSON.parse(listText) as { data: Array<{ pid: string; stats: { total: { order_count: number } } }> };
    expect(list.data.find((item) => item.pid === body.pid)?.stats.total.order_count).toBe(1);

    // Duplicate login usernames are rejected.
    const dup = await app.request("http://localhost/admin-api/merchants", { method: "POST", headers, body: JSON.stringify({ name: "Shop C", username: "shopb" }) });
    expect(dup.status).toBe(409);
  });

  it("rejects API calls from disabled merchants and refuses deleting merchants with orders", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const headers = adminHeaders(database);
    const merchant = getMerchantByPid(database, "1000000001")!;
    createOrder(database, orderInput(1));

    const disabled = await app.request(`http://localhost/admin-api/merchants/${merchant.id}`, { method: "PUT", headers, body: JSON.stringify({ status: "disabled" }) });
    expect(disabled.status).toBe(200);
    const rejected = await app.request("http://localhost/mapi.php", { method: "POST", headers: formHeaders, body: v1Order("1000000001", "1234567890abcdef1234567890abcdef", "X-1") });
    const rejectedBody = await rejected.json() as { code: number; msg: string };
    expect(rejectedBody.code).toBe(-1);
    expect(rejectedBody.msg).toContain("禁用");

    expect((await app.request(`http://localhost/admin-api/merchants/${merchant.id}`, { method: "DELETE", headers })).status).toBe(409);
    const empty = await createMerchant(database, { name: "Empty" });
    expect((await app.request(`http://localhost/admin-api/merchants/${empty.merchant.id}`, { method: "DELETE", headers })).status).toBe(200);
  });

  it("regenerating a merchant key invalidates only that merchant's old key", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const headers = adminHeaders(database);
    const other = await createMerchant(database, { name: "Other" });
    const merchant = getMerchantByPid(database, "1000000001")!;
    const regenerated = await (await app.request(`http://localhost/admin-api/merchants/${merchant.id}/keys/v1/regenerate`, { method: "POST", headers })).json() as { key: string };
    expect(regenerated.key).not.toBe("1234567890abcdef1234567890abcdef");
    expect(getMerchantV1Key(getMerchantByPid(database, other.merchant.pid)!)).toBe(other.v1Key);
    const stale = await app.request("http://localhost/mapi.php", { method: "POST", headers: formHeaders, body: v1Order("1000000001", "1234567890abcdef1234567890abcdef", "S-1") });
    expect((await stale.json() as { code: number }).code).toBe(-1);
  });
});

describe("per-merchant notifications", () => {
  it("signs V1 callbacks with the order's merchant key", async () => {
    ({ database } = configuredDatabase());
    const other = await createMerchant(database, { name: "Other" });
    const order = createOrder(database, { ...orderInput(1), pid: other.merchant.pid }).order;
    recordAndMatchPayment(database, {
      accountLogId: "LOG-OTHER", occurredAt: new Date().toISOString(), direction: "收入",
      amountCents: order.payable_amount_cents, alipayOrderNo: "", transMemo: "", otherAccount: "", raw: {},
    }, getActiveOrders(database));
    const fetcher = mock(async (input: string | URL | Request) => {
      const params = Object.fromEntries(new URL(String(input)).searchParams);
      expect(params.pid).toBe(other.merchant.pid);
      expect(verifyMd5(params, other.v1Key)).toBe(true);
      expect(verifyMd5(params, "1234567890abcdef1234567890abcdef")).toBe(false);
      return new Response("success");
    }) as unknown as typeof fetch;
    await new NotificationWorker(database, fetcher).tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("merchant portal", () => {
  async function login(app: ReturnType<typeof appFor>, username: string, password: string) {
    const response = await app.request("http://localhost/merchant-api/login", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ username, password }),
    });
    const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]!);
    const csrf = cookies.find((value) => value.startsWith("alimpay_merchant_csrf="))?.split("=")[1] ?? "";
    return { status: response.status, cookie: cookies.join("; "), csrf };
  }

  it("lets a merchant see only its own orders and stats", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const mine = await createMerchant(database, { name: "Mine", username: "mine", password: "mine-password", feeRateBp: 100 });
    const myOrder = createOrder(database, { ...orderInput(1), pid: mine.merchant.pid, money: "50.00" }).order;
    const foreign = createOrder(database, orderInput(2)).order;
    database.query("UPDATE orders SET status = 'paid', paid_at = created_at WHERE id = ?").run(myOrder.id);

    expect((await login(app, "mine", "wrong-password")).status).toBe(401);
    const session = await login(app, "mine", "mine-password");
    expect(session.status).toBe(200);
    const get = (path: string) => app.request(`http://localhost/merchant-api${path}`, { headers: { cookie: session.cookie } });

    const orders = await (await get("/orders")).json() as { total: number; data: Array<{ id: string; checkout_token?: string }> };
    expect(orders.total).toBe(1);
    expect(orders.data[0]!.id).toBe(myOrder.id);
    expect(orders.data[0]!.checkout_token).toBeUndefined();
    expect((await get(`/orders/${foreign.id}`)).status).toBe(404);

    const dashboard = await (await get("/dashboard")).json() as { stats: { total: { paid_cents: number; fee_cents: number; net_cents: number } } };
    expect(dashboard.stats.total).toMatchObject({ paid_cents: 5_000, fee_cents: 50, net_cents: 4_950 });

    // Admin endpoints stay off-limits to merchant sessions.
    expect((await app.request("http://localhost/admin-api/orders", { headers: { cookie: session.cookie } })).status).toBe(401);

    // Mutations need the merchant CSRF token.
    const noCsrf = await app.request("http://localhost/merchant-api/keys/v1/regenerate", { method: "POST", headers: { cookie: session.cookie, origin: "http://localhost" } });
    expect(noCsrf.status).toBe(403);
    const regenerated = await app.request("http://localhost/merchant-api/keys/v1/regenerate", {
      method: "POST", headers: { cookie: session.cookie, origin: "http://localhost", "x-csrf-token": session.csrf },
    });
    expect(regenerated.status).toBe(200);
    expect(((await regenerated.json()) as { key: string }).key).not.toBe(mine.v1Key);
  });

  it("blocks login and ends sessions when the merchant is disabled", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const mine = await createMerchant(database, { name: "Mine", username: "mine", password: "mine-password" });
    const session = await login(app, "mine", "mine-password");
    database.query("UPDATE merchants SET status = 'disabled' WHERE id = ?").run(mine.merchant.id);
    expect((await app.request("http://localhost/merchant-api/me", { headers: { cookie: session.cookie } })).status).toBe(403);
    expect((await login(app, "mine", "mine-password")).status).toBe(403);
  });
});

describe("legacy single-merchant migration", () => {
  it("turns the former merchant_pid and V1 key into a merchant row", () => {
    const path = join(tmpdir(), `alimpay-migrate-${crypto.randomUUID()}.sqlite`);
    try {
      const legacy = createDatabase(path);
      setSetting(legacy, "merchant_pid", "1234567890");
      setSecret(legacy, "v1_key", "legacykeylegacykeylegacykey12345");
      setSetting(legacy, "v2_merchant_public_key", "");
      legacy.exec("DELETE FROM merchants; DELETE FROM schema_migrations WHERE version = 4; DROP TABLE merchant_sessions; DROP TABLE merchants;");
      legacy.exec("DROP INDEX idx_orders_pid_created; ALTER TABLE orders DROP COLUMN fee_cents; ALTER TABLE orders DROP COLUMN fee_rate_bp;");
      legacy.close();

      database = createDatabase(path);
      const merchant = getMerchantByPid(database, "1234567890");
      expect(merchant?.name).toBe("默认商户");
      expect(getMerchantV1Key(merchant!)).toBe("legacykeylegacykeylegacykey12345");
    } finally {
      database?.close();
      database = undefined;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});
