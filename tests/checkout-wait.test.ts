import { afterEach, describe, expect, it, mock } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import type { AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { createOrder, getActiveOrders, recordAndMatchPayment } from "../src/server/orders";
import type { CheckoutData } from "../src/shared/contracts";
import { configuredDatabase, orderInput } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
let worker: NotificationWorker | undefined;
afterEach(() => {
  worker?.stop();
  worker = undefined;
  database?.close();
});

function pay(db: AppDatabase, amountCents: number, id = "LOG-WAIT") {
  return recordAndMatchPayment(db, {
    accountLogId: id, occurredAt: new Date().toISOString(), direction: "收入",
    amountCents, alipayOrderNo: "ALI-WAIT", transMemo: "", otherAccount: "buyer", raw: {},
  }, getActiveOrders(db));
}

describe("checkout long-poll", () => {
  it("returns the moment the order is paid, then again once the merchant acknowledges", async () => {
    ({ database } = configuredDatabase());
    const db = database;
    const order = createOrder(db, orderInput(1)).order;
    const scanner = new PaymentScanner(db, new EmptyProvider());
    // Pretend a scan just ran so the wait endpoint does not trigger one.
    await scanner.scanNow("test");
    const { app } = createApp({ database: db, scanner, notifications: new NotificationWorker(db, fetch) });

    const started = Date.now();
    const waiting = app.request(`http://localhost/public-api/checkout/${order.checkout_token}/wait?since=pending`);
    setTimeout(() => pay(db, order.payable_amount_cents), 150);
    const paid = await (await waiting).json() as CheckoutData;
    expect(paid.status).toBe("paid");
    expect(paid.notify_delivered).toBe(false);
    expect(paid.return_target).toContain("trade_status=TRADE_SUCCESS");
    expect(Date.now() - started).toBeLessThan(2_000);

    const notified = app.request(`http://localhost/public-api/checkout/${order.checkout_token}/wait?since=paid`);
    worker = new NotificationWorker(db, mock(async () => new Response("success")) as unknown as typeof fetch);
    setTimeout(() => void worker!.tick(), 100);
    const body = await (await notified).json() as CheckoutData;
    expect(body.notify_delivered).toBe(true);
  });

  it("answers immediately when the state already differs", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    pay(database, order.payable_amount_cents);
    const { app } = createApp({ database, scanner: new PaymentScanner(database, new EmptyProvider()), notifications: new NotificationWorker(database, fetch) });
    const started = Date.now();
    const body = await (await app.request(`http://localhost/public-api/checkout/${order.checkout_token}/wait?since=pending`)).json() as CheckoutData;
    expect(body.status).toBe("paid");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("immediate notification", () => {
  it("delivers the merchant callback as soon as the payment is matched", async () => {
    ({ database } = configuredDatabase());
    const order = createOrder(database, orderInput(1)).order;
    let deliveredAt = 0;
    const fetcher = mock(async () => { deliveredAt = Date.now(); return new Response("success"); }) as unknown as typeof fetch;
    worker = new NotificationWorker(database, fetcher);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the initial tick finish
    const paidAt = Date.now();
    pay(database, order.payable_amount_cents);
    for (let i = 0; i < 40 && !deliveredAt; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Well under the 500ms worker interval: delivery is event-driven.
    expect(deliveredAt - paidAt).toBeLessThan(250);
  });
});
