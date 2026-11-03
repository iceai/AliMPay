import { createSign, createVerify } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "bun:test";
import { OfficialAlipayProvider } from "../src/server/alipay";
import { setSecret } from "../src/server/config";
import { setSetting, type AppDatabase } from "../src/server/db";
import { generateRsaKeyPair, toSpkiPublicKey } from "../src/server/security";
import { configuredDatabase } from "./helpers";

let database: AppDatabase | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  database?.close();
});

const page = { page_no: "1", page_size: "2000", total_size: "1", detail_list: [{ account_log_id: "L1", direction: "收入", trans_amount: "3.36", trans_dt: "2026-11-03 17:00:00" }] };

function fakeAlipay(options: { app: { publicKey: string }; alipay: { privateKey: string }; gzip?: boolean; tamper?: boolean; status?: number }) {
  const seen: { authorizationValid?: boolean; acceptEncoding?: string | null } = {};
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";
      const [, auth = "", sign = ""] = /^ALIPAY-SHA256withRSA (.*),sign=(.*)$/.exec(authorization) ?? [];
      seen.authorizationValid = createVerify("RSA-SHA256").update(`${auth}\nGET\n${url.pathname}${url.search}\n\n`, "utf8")
        .verify(toSpkiPublicKey(options.app.publicKey), sign, "base64");
      seen.acceptEncoding = request.headers.get("accept-encoding");
      const body = options.status ? JSON.stringify({ code: "isv.invalid-app-id", message: "应用不存在" }) : JSON.stringify(page);
      const timestamp = String(Date.now());
      const nonce = "nonce-1";
      const signature = createSign("RSA-SHA256").update(`${timestamp}\n${nonce}\n${body}\n`, "utf8").sign(options.alipay.privateKey, "base64");
      const sent = options.tamper ? body.replace("3.36", "9.99") : body;
      return new Response(options.gzip ? gzipSync(sent) : sent, {
        status: options.status ?? 200,
        headers: {
          "content-type": "application/json",
          ...(options.gzip ? { "content-encoding": "gzip" } : {}),
          "alipay-timestamp": timestamp,
          "alipay-nonce": nonce,
          "alipay-signature": signature,
          "alipay-trace-id": "trace-xyz",
        },
      });
    },
  });
  return seen;
}

function setup() {
  ({ database } = configuredDatabase());
  const app = generateRsaKeyPair();
  const alipay = generateRsaKeyPair();
  setSecret(database, "alipay_private_key", app.privateKey);
  setSetting(database, "alipay_public_key", alipay.publicKey);
  return { app, alipay };
}

const query = { startTime: "2026-11-03 16:00:00", endTime: "2026-11-03 18:00:00", pageNo: 1, pageSize: 2000 };

describe("Alipay V3 account log provider", () => {
  it("signs the request, asks for an uncompressed body and parses a gzip response", async () => {
    const keys = setup();
    const seen = fakeAlipay({ ...keys, gzip: true });
    setSetting(database!, "alipay_endpoint", `http://127.0.0.1:${server!.port}`);
    const result = await new OfficialAlipayProvider(database!).query(query);
    expect(seen.authorizationValid).toBe(true);
    expect(seen.acceptEncoding).toBe("identity");
    expect(result.totalSize).toBe(1);
    expect(result.details[0]?.account_log_id).toBe("L1");
    expect(result.traceId).toBe("trace-xyz");
  });

  it("rejects a response whose signature does not match", async () => {
    const keys = setup();
    fakeAlipay({ ...keys, tamper: true });
    setSetting(database!, "alipay_endpoint", `http://127.0.0.1:${server!.port}`);
    await expect(new OfficialAlipayProvider(database!).query(query)).rejects.toThrow("验签失败");
  });

  it("surfaces Alipay error messages", async () => {
    const keys = setup();
    fakeAlipay({ ...keys, status: 400 });
    setSetting(database!, "alipay_endpoint", `http://127.0.0.1:${server!.port}`);
    await expect(new OfficialAlipayProvider(database!).query(query)).rejects.toThrow("应用不存在");
  });
});
