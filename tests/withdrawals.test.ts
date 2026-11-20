import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import { setSetting, type AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { createMerchant } from "../src/server/merchants";
import { NotificationWorker } from "../src/server/notifications";
import { createOrder } from "../src/server/orders";
import { sha256 } from "../src/server/security";
import {
  cancelWithdrawal,
  getMerchantBalance,
  markWithdrawalPaid,
  maxWithdrawable,
  rejectWithdrawal,
  requestWithdrawal,
} from "../src/server/withdrawals";
import { configuredDatabase, orderInput } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

const account = { accountType: "alipay", accountNo: "payee@example.com", accountName: "张三" };

/** A merchant with ¥100 order income at a 1% order fee → ¥99.00 net. */
async function fundedMerchant(db: AppDatabase, name = "Shop", username = "shop") {
  const { merchant } = await createMerchant(db, { name, username, password: "shop-password", feeRateBp: 100 });
  const order = createOrder(db, { ...orderInput(Math.floor(Math.random() * 1e9)), pid: merchant.pid, money: "100.00" }).order;
  db.query("UPDATE orders SET status = 'paid', paid_at = created_at WHERE id = ?").run(order.id);
  return merchant;
}

describe("withdrawal balance rules", () => {
  it("freezes amount + 8% fee on request and deducts it once paid", async () => {
    ({ database } = configuredDatabase());
    const merchant = await fundedMerchant(database);
    expect(getMerchantBalance(database, merchant)).toEqual({ income_cents: 9_900, frozen_cents: 0, withdrawn_cents: 0, available_cents: 9_900 });

    const withdrawal = requestWithdrawal(database, merchant, { ...account, amount: "50" });
    expect(withdrawal).toMatchObject({ amount_cents: 5_000, fee_rate_bp: 800, fee_cents: 400, total_cents: 5_400, status: "pending" });
    expect(getMerchantBalance(database, merchant)).toMatchObject({ frozen_cents: 5_400, withdrawn_cents: 0, available_cents: 4_500 });

    markWithdrawalPaid(database, withdrawal.id, "admin", "ALIPAY-REF-1");
    expect(getMerchantBalance(database, merchant)).toMatchObject({ frozen_cents: 0, withdrawn_cents: 5_400, available_cents: 4_500 });
    expect(() => markWithdrawalPaid(database!, withdrawal.id, "admin")).toThrow("已处理");
    expect(() => rejectWithdrawal(database!, withdrawal.id, "admin", "late")).toThrow("已处理");
  });

  it("releases the frozen amount on rejection or cancellation", async () => {
    ({ database } = configuredDatabase());
    const merchant = await fundedMerchant(database);
    const first = requestWithdrawal(database, merchant, { ...account, amount: "10" });
    expect(() => rejectWithdrawal(database!, first.id, "admin", " ")).toThrow("驳回原因");
    rejectWithdrawal(database, first.id, "admin", "账号有误");
    const second = requestWithdrawal(database, merchant, { ...account, amount: "10" });
    cancelWithdrawal(database, second.id, merchant.id);
    expect(getMerchantBalance(database, merchant)).toMatchObject({ frozen_cents: 0, withdrawn_cents: 0, available_cents: 9_900 });
  });

  it("refuses requests beyond the available balance, counting pending ones", async () => {
    ({ database } = configuredDatabase());
    const merchant = await fundedMerchant(database);
    const max = maxWithdrawable(9_900, 800);
    expect(max + Math.round(max * 0.08)).toBeLessThanOrEqual(9_900);
    expect(max + 1 + Math.round((max + 1) * 0.08)).toBeGreaterThan(9_900);
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: ((max + 1) / 100).toFixed(2) })).toThrow("可用余额不足");
    requestWithdrawal(database, merchant, { ...account, amount: "60" });
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: "40" })).toThrow("可用余额不足");
  });

  it("enforces settings and payee details", async () => {
    ({ database } = configuredDatabase());
    const merchant = await fundedMerchant(database);
    setSetting(database, "withdraw_min_cents", 2_000);
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: "10" })).toThrow("最低提现");
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: "20", accountType: "bank" })).toThrow("开户银行");
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: "20", accountName: "" })).toThrow("真实姓名");
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: "abc" })).toThrow("金额格式错误");
    setSetting(database, "withdraw_fee_rate_bp", 0);
    expect(requestWithdrawal(database, merchant, { ...account, amount: "20" }).fee_cents).toBe(0);
    setSetting(database, "withdraw_enabled", false);
    expect(() => requestWithdrawal(database!, merchant, { ...account, amount: "20" })).toThrow("暂未开放");
  });
});

describe("withdrawal API", () => {
  async function merchantSession(app: ReturnType<typeof createApp>["app"], username: string) {
    const response = await app.request("http://localhost/merchant-api/login", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ username, password: "shop-password" }),
    });
    const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]!);
    const csrf = cookies.find((value) => value.startsWith("alimpay_merchant_csrf="))!.split("=")[1]!;
    return { cookie: cookies.join("; "), "x-csrf-token": csrf, origin: "http://localhost", "content-type": "application/json" };
  }

  function adminHeaders(db: AppDatabase) {
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    db.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', 'unused', ?, ?)").run(userId, now, now);
    db.query("INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), userId, sha256("admin-token"), new Date(Date.now() + 60_000).toISOString(), now, now);
    return { cookie: "alimpay_session=admin-token; alimpay_csrf=c", "x-csrf-token": "c", origin: "http://localhost", "content-type": "application/json" };
  }

  it("runs request → admin pay end to end and keeps merchants isolated", async () => {
    ({ database } = configuredDatabase());
    const db = database;
    const { app } = createApp({ database: db, scanner: new PaymentScanner(db, new EmptyProvider()), notifications: new NotificationWorker(db, fetch) });
    const shop = await fundedMerchant(db, "Shop", "shop");
    await fundedMerchant(db, "Other", "other");
    const shopHeaders = await merchantSession(app, "shop");
    const otherHeaders = await merchantSession(app, "other");
    const admin = adminHeaders(db);

    const created = await app.request("http://localhost/merchant-api/withdrawals", {
      method: "POST", headers: shopHeaders,
      body: JSON.stringify({ amount: "25.00", account_type: "alipay", account_no: "shop@example.com", account_name: "李四" }),
    });
    expect(created.status).toBe(201);
    const { withdrawal } = await created.json() as { withdrawal: { id: string; fee_cents: number } };
    expect(withdrawal.fee_cents).toBe(200);

    // Another merchant can neither see nor cancel it.
    const otherList = await (await app.request("http://localhost/merchant-api/withdrawals", { headers: otherHeaders })).json() as { total: number };
    expect(otherList.total).toBe(0);
    expect((await app.request(`http://localhost/merchant-api/withdrawals/${withdrawal.id}/cancel`, { method: "POST", headers: otherHeaders })).status).toBe(404);

    const adminList = await (await app.request("http://localhost/admin-api/withdrawals?status=pending", { headers: admin })).json() as { total: number; data: Array<{ merchant_name: string }>; pending: { count: number } };
    expect(adminList.total).toBe(1);
    expect(adminList.data[0]!.merchant_name).toBe("Shop");
    expect(adminList.pending.count).toBe(1);

    const paid = await app.request(`http://localhost/admin-api/withdrawals/${withdrawal.id}/pay`, { method: "POST", headers: admin, body: JSON.stringify({ payout_ref: "REF-9" }) });
    expect(paid.status).toBe(200);
    expect((await app.request(`http://localhost/admin-api/withdrawals/${withdrawal.id}/pay`, { method: "POST", headers: admin, body: "{}" })).status).toBe(409);

    const mine = await (await app.request("http://localhost/merchant-api/withdrawals", { headers: shopHeaders })).json() as {
      balance: { withdrawn_cents: number; available_cents: number }; data: Array<{ status: string; payout_ref: string }>; last_account: { account_no: string };
    };
    expect(mine.balance).toMatchObject({ withdrawn_cents: 2_700, available_cents: 9_900 - 2_700 });
    expect(mine.data[0]).toMatchObject({ status: "paid", payout_ref: "REF-9" });
    expect(mine.last_account.account_no).toBe("shop@example.com");
    expect(getMerchantBalance(db, shop).available_cents).toBe(7_200);
  });

  it("lets the admin change the fee rate and minimum", async () => {
    ({ database } = configuredDatabase());
    const { app } = createApp({ database, scanner: new PaymentScanner(database, new EmptyProvider()), notifications: new NotificationWorker(database, fetch) });
    const admin = adminHeaders(database);
    const response = await app.request("http://localhost/admin-api/withdrawal-settings", { method: "PUT", headers: admin, body: JSON.stringify({ fee_rate: "5.5", min_amount: "10" }) });
    const body = await response.json() as { settings: { fee_rate_bp: number; min_cents: number; fee_rate: string } };
    expect(body.settings).toMatchObject({ fee_rate_bp: 550, min_cents: 1_000, fee_rate: "5.5" });
  });
});
