import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import { addBlacklistEntry, blockRuleForAddress, matchBlockedIp, parseIpRule } from "../src/server/blacklist";
import type { AppDatabase } from "../src/server/db";
import { resetRuntimeEnvForTests } from "../src/server/env";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { createOrder, getActiveOrders, getOrderById, linkPaymentToOrder, recordAndMatchPayment } from "../src/server/orders";
import { md5Sign, sha256 } from "../src/server/security";
import type { CheckoutData } from "../src/shared/contracts";
import { configuredDatabase, orderInput } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
afterEach(() => {
  database?.close();
  delete process.env.TRUST_PROXY;
  resetRuntimeEnvForTests();
});

const KEY = "1234567890abcdef1234567890abcdef";
const block = (db: AppDatabase, kind: "ip" | "alipay_account", value: string) => addBlacklistEntry(db, { kind, value, createdBy: "test" }).entry;

function appFor(db: AppDatabase) {
  return createApp({ database: db, scanner: new PaymentScanner(db, new EmptyProvider()), notifications: new NotificationWorker(db, fetch) }).app;
}

function signedOrder(outTradeNo: string, clientip: string) {
  const unsigned = {
    pid: "1000000001", type: "alipay", out_trade_no: outTradeNo, notify_url: "https://merchant.example/notify",
    return_url: "https://merchant.example/return", name: "Item", money: "8.88", clientip, sign_type: "MD5",
  };
  return new URLSearchParams({ ...unsigned, sign: md5Sign(unsigned, KEY) }).toString();
}

function pay(db: AppDatabase, amountCents: number, otherAccount = "**明(138******88)", id = `LOG-${crypto.randomUUID()}`) {
  return recordAndMatchPayment(db, {
    accountLogId: id, occurredAt: new Date().toISOString(), direction: "收入",
    amountCents, alipayOrderNo: "", transMemo: "", otherAccount, raw: {},
  }, getActiveOrders(db));
}

describe("IP rules", () => {
  it("matches exact addresses, IPv4 ranges, IPv6 /64 and IPv4-mapped IPv6", () => {
    ({ database } = configuredDatabase());
    block(database, "ip", "203.0.113.7");
    block(database, "ip", "198.51.100.0/24");
    block(database, "ip", "2408:8207:1234:5678::/64");
    expect(matchBlockedIp(database, ["203.0.113.7"])).not.toBeNull();
    expect(matchBlockedIp(database, ["203.0.113.8"])).toBeNull();
    expect(matchBlockedIp(database, ["198.51.100.250"])).not.toBeNull();
    expect(matchBlockedIp(database, ["2408:8207:1234:5678:aaaa:bbbb:cccc:dddd"])).not.toBeNull();
    expect(matchBlockedIp(database, ["2408:8207:1234:5679::1"])).toBeNull();
    expect(matchBlockedIp(database, ["::ffff:203.0.113.7"])).not.toBeNull();
    expect(matchBlockedIp(database, ["", "not-an-ip"])).toBeNull();
  });

  it("normalizes rules and refuses overly broad or invalid ones", () => {
    expect(blockRuleForAddress("2408:8207:1234:5678:aaaa:bbbb:cccc:dddd")).toBe("2408:8207:1234:5678::/64");
    expect(blockRuleForAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(blockRuleForAddress("")).toBeNull();
    expect(parseIpRule("10.0.0.0/4")).toBeNull();
    expect(parseIpRule("::/0")).toBeNull();
    expect(parseIpRule("999.1.1.1")).toBeNull();
    ({ database } = configuredDatabase());
    expect(block(database, "ip", "2001:DB8:0:0:1:0:0:0/128").value).toBe("2001:db8:0:0:1::");
    expect(() => block(database!, "ip", "abc")).toThrow("IP 格式错误");
  });
});

describe("blocking before payment", () => {
  it("refuses to create an order for a blacklisted buyer IP", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    block(database, "ip", "203.0.113.66");
    const blocked = await app.request("http://localhost/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: signedOrder("B-1", "203.0.113.66") });
    expect(await blocked.json()).toEqual({ code: -1, msg: "当前无法为您提供支付服务，请联系商家" });
    expect(database.query("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
    const allowed = await app.request("http://localhost/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: signedOrder("B-2", "203.0.113.67") });
    expect((await allowed.json() as { code: number }).code).toBe(1);
    expect((database.query("SELECT hits FROM blacklist").get() as { hits: number }).hits).toBe(1);
  });

  it("checks the browser's own IP on page-jump checkout, using Cloudflare's header", async () => {
    process.env.TRUST_PROXY = "true";
    resetRuntimeEnvForTests();
    ({ database } = configuredDatabase());
    const app = appFor(database);
    block(database, "ip", "203.0.113.66");
    const response = await app.request("http://localhost/submit.php", {
      method: "POST",
      // A forged X-Forwarded-For must not hide the real address Cloudflare reports.
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.66", "x-forwarded-for": "8.8.8.8" },
      body: signedOrder("B-3", "198.18.0.1"),
    });
    expect((await response.json() as { code: number }).code).toBe(-1);
  });

  it("locks an open checkout once the buyer is blacklisted, so a later payment cannot confirm it", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const order = createOrder(database, { ...orderInput(1), clientIp: "203.0.113.99" }).order;
    const before = await (await app.request(`http://localhost/public-api/checkout/${order.checkout_token}`)).json() as CheckoutData;
    expect(before.blocked).toBe(false);
    expect(before.business_qr_url).not.toBe("");

    block(database, "ip", "203.0.113.99");
    const after = await (await app.request(`http://localhost/public-api/checkout/${order.checkout_token}`)).json() as CheckoutData;
    expect(after.blocked).toBe(true);
    expect(after.business_qr_url).toBe("");
    expect(after.payment_uri).toBe("");
    expect(getOrderById(database, order.id)?.blocked_at).not.toBeNull();
    expect(database.query("SELECT COUNT(*) AS n FROM amount_reservations WHERE order_id = ?").get(order.id)).toEqual({ n: 0 });

    // Paying the exact amount anyway does not confirm the order.
    const result = pay(database, order.payable_amount_cents, "*王(139******01)");
    expect(result.matched).toBe(false);
    expect(getOrderById(database, order.id)?.status).toBe("pending");
    expect(() => linkPaymentToOrder(database!, result.eventId!, order.id)).toThrow("黑名单");
  });

  it("blocks a checkout opened from a blacklisted visitor IP", async () => {
    process.env.TRUST_PROXY = "true";
    resetRuntimeEnvForTests();
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const order = createOrder(database, { ...orderInput(1), clientIp: "198.18.0.1" }).order;
    block(database, "ip", "2408:8207:1234:5678::/64");
    const body = await (await app.request(`http://localhost/public-api/checkout/${order.checkout_token}/wait?since=pending`, {
      headers: { "cf-connecting-ip": "2408:8207:1234:5678:1:2:3:4" },
    })).json() as CheckoutData;
    expect(body.blocked).toBe(true);
    expect(getOrderById(database, order.id)?.blocked_at).not.toBeNull();
  });
});

describe("blacklisted Alipay accounts", () => {
  it("never let a blacklisted payer's money confirm any order", () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    const entry = block(database, "alipay_account", "  **明(138******88) ");
    expect(entry.value).toBe("**明(138******88)");
    const result = pay(database, order.payable_amount_cents, "**明(138******88)");
    expect(result.matched).toBe(false);
    expect(getOrderById(database, order.id)?.status).toBe("pending");
    expect((database.query("SELECT blacklist_id FROM payment_events WHERE id = ?").get(result.eventId!) as { blacklist_id: string }).blacklist_id).toBe(entry.id);
    expect(database.query("SELECT COUNT(*) AS n FROM notification_jobs").get()).toEqual({ n: 0 });
    // Someone else paying the same amount is unaffected.
    expect(pay(database, order.payable_amount_cents, "*李(186******20)").matched).toBe(true);
  });
});

describe("admin one-click block", () => {
  it("adds the order's IP (as /64 for IPv6) and the payer account, and locks the order", async () => {
    ({ database } = configuredDatabase());
    const app = appFor(database);
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    database.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'ops', 'x', ?, ?)").run(userId, now, now);
    database.query("INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), userId, sha256("t"), new Date(Date.now() + 60_000).toISOString(), now, now);
    const headers = { cookie: "alimpay_session=t; alimpay_csrf=c", "x-csrf-token": "c", origin: "http://localhost", "content-type": "application/json" };

    const order = createOrder(database, { ...orderInput(1), clientIp: "2408:8207:1234:5678:9:9:9:9" }).order;
    database.query("UPDATE orders SET buyer = '**明(138******88)' WHERE id = ?").run(order.id);
    const response = await app.request(`http://localhost/admin-api/orders/${order.id}/blacklist`, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    const { added } = await response.json() as { added: Array<{ kind: string; value: string }> };
    expect(added.map((entry) => entry.value).sort()).toEqual(["**明(138******88)", "2408:8207:1234:5678::/64"]);
    expect(getOrderById(database, order.id)?.blocked_at).not.toBeNull();

    const list = await (await app.request("http://localhost/admin-api/blacklist", { headers })).json() as { data: Array<{ id: string }> };
    expect(list.data).toHaveLength(2);
    expect((await app.request(`http://localhost/admin-api/blacklist/${list.data[0]!.id}`, { method: "DELETE", headers })).status).toBe(200);
  });
});
