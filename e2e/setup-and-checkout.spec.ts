import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

function md5(parameters: Record<string, string>, key: string) {
  const canonical = Object.entries(parameters)
    .filter(([name, value]) => name !== "sign" && name !== "sign_type" && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return createHash("md5").update(`${canonical}${key}`).digest("hex");
}

test("first-run setup, key generation, QR upload and public checkout", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "The full write flow runs once on desktop; mobile has a focused navigation assertion below.");
  await page.goto("/admin/setup");
  await expect(page.getByRole("heading", { name: "先完成三项基础配置" })).toBeVisible();
  await page.getByLabel("公开访问地址").fill("http://127.0.0.1:3100");
  await page.getByLabel("管理员用户名").fill("e2e-admin");
  await page.getByLabel("管理员密码", { exact: true }).fill("Test-password-2026");
  await page.getByLabel("确认密码").fill("Test-password-2026");
  await page.getByRole("button", { name: /创建并进入后台/ }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible();

  await page.getByRole("link", { name: "密钥中心" }).click();
  await page.getByRole("button", { name: "生成应用密钥" }).click();
  const disclosure = page.getByRole("dialog");
  await expect(disclosure.getByText("支付宝应用密钥")).toBeVisible();
  const privateKey = await disclosure.locator("textarea").nth(0).inputValue();
  const publicKey = await disclosure.locator("textarea").nth(1).inputValue();
  expect(privateKey).toMatch(/^[A-Za-z\d+/]+=*$/);
  expect(privateKey).not.toContain("BEGIN PRIVATE KEY");
  expect(privateKey).not.toContain("\n");
  expect(publicKey).toMatch(/^[A-Za-z\d+/]+=*$/);
  expect(publicKey).not.toContain("BEGIN PUBLIC KEY");
  expect(publicKey).not.toContain("\n");
  await disclosure.getByRole("button", { name: "关闭" }).click();
  await page.getByLabel("导入已有应用私钥").fill(privateKey);
  await page.getByRole("button", { name: "导入私钥" }).click();
  await expect(page.getByText("应用私钥已导入")).toBeVisible();

  await page.getByRole("link", { name: "商户管理", exact: true }).click();
  await page.getByRole("link", { name: "默认商户" }).click();
  await page.getByRole("button", { name: "生成商户密钥对" }).click();
  const merchantDisclosure = page.getByRole("dialog");
  await expect(merchantDisclosure.getByText(/私钥只在本次响应中展示/)).toBeVisible();
  const merchantPrivateKey = await merchantDisclosure.locator("textarea").nth(0).inputValue();
  const merchantPublicKey = await merchantDisclosure.locator("textarea").nth(1).inputValue();
  expect(merchantPrivateKey).toMatch(/^[A-Za-z\d+/]+=*$/);
  expect(merchantPrivateKey).not.toContain("BEGIN PRIVATE KEY");
  expect(merchantPrivateKey).not.toContain("\n");
  expect(merchantPublicKey).toMatch(/^[A-Za-z\d+/]+=*$/);
  expect(merchantPublicKey).not.toContain("BEGIN PUBLIC KEY");
  await merchantDisclosure.getByRole("button", { name: "关闭" }).click();
  await page.getByLabel("导入已有商户公钥").fill(merchantPublicKey);
  await page.getByRole("button", { name: "导入公钥" }).click();
  await expect(page.getByText("商户公钥已导入")).toBeVisible();

  await page.getByRole("link", { name: "收款配置" }).click();
  await page.getByLabel("应用 ID").fill("2026000000000000");
  await page.getByLabel("支付宝公钥").fill(publicKey);
  await page.getByLabel("支付轮询间隔（秒）").fill("2");
  await page.getByLabel("经营码图片").setInputFiles({
    name: "business-qr.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByText("已上传", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /保存全部配置/ }).click();
  await expect(page.getByText("配置已保存")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("支付轮询间隔（秒）")).toHaveValue("2");

  await page.getByRole("link", { name: "商户管理", exact: true }).click();
  await page.getByRole("link", { name: "默认商户" }).click();
  await page.getByRole("button", { name: "查看凭据" }).click();
  const credentials = await page.getByRole("dialog").locator("textarea").inputValue();
  const pid = credentials.match(/PID=(\d+)/)?.[1] ?? "";
  const key = credentials.match(/KEY=([^\n]+)/)?.[1] ?? "";
  expect(pid).not.toBe("");
  expect(key).not.toBe("");

  const unsigned = {
    pid,
    type: "alipay",
    out_trade_no: `E2E-${Date.now()}`,
    notify_url: "https://8.8.8.8/notify",
    return_url: "https://8.8.8.8/return",
    name: "E2E order",
    money: "1.00",
    clientip: "203.0.113.10",
    sign_type: "MD5",
  };
  const response = await request.post("/mapi.php", { form: { ...unsigned, sign: md5(unsigned, key) } });
  const responseText = await response.text();
  expect(response.ok(), responseText).toBeTruthy();
  const order = JSON.parse(responseText) as { code: number; payurl: string };
  expect(order.code).toBe(1);
  await page.goto(order.payurl);
  await expect(page.getByRole("heading", { name: "¥1.00" })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByAltText("支付宝经营码")).toBeVisible();

  // A second merchant with its own key, a fee rate and its own portal shares the same QR code.
  await page.goto("/admin/merchants");
  await page.getByRole("button", { name: "新建商户" }).first().click();
  await page.getByLabel("商户名称").fill("E2E Shop");
  await page.getByLabel("后台登录用户名").fill("e2eshop");
  await page.getByLabel("后台登录密码").fill("e2e-shop-password");
  await page.getByLabel("手续费（%）").fill("2");
  await page.getByRole("button", { name: "创建商户" }).click();
  const shopCredentials = await page.getByRole("dialog").locator("textarea").inputValue();
  const shopPid = shopCredentials.match(/PID=(\d+)/)?.[1] ?? "";
  const shopKey = shopCredentials.match(/KEY=([^\n]+)/)?.[1] ?? "";
  expect(shopPid).not.toBe(pid);
  expect(shopKey).not.toBe(key);
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("link", { name: "E2E Shop" })).toBeVisible();

  const shopOrder = { ...unsigned, pid: shopPid, out_trade_no: `SHOP-${Date.now()}`, money: "10.00" };
  const shopResponse = await request.post("/mapi.php", { form: { ...shopOrder, sign: md5(shopOrder, shopKey) } });
  const shopBody = await shopResponse.json() as { code: number; payurl: string };
  expect(shopBody.code).toBe(1);
  const crossedOrder = { ...shopOrder, pid, out_trade_no: "CROSS-1" };
  const crossed = await request.post("/mapi.php", { form: { ...crossedOrder, sign: md5(crossedOrder, shopKey) } });
  expect((await crossed.json() as { code: number }).code).toBe(-1);
  await page.goto(shopBody.payurl);
  await expect(page.getByAltText("支付宝经营码")).toBeVisible({ timeout: 12_000 });

  await page.goto("/merchant/login");
  await page.getByLabel("用户名").fill("e2eshop");
  await page.getByLabel("密码").fill("e2e-shop-password");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page.getByRole("heading", { name: "数据概览" })).toBeVisible();
  await expect(page.getByText("当前手续费率 2%")).toBeVisible();
  await page.getByRole("link", { name: "订单", exact: true }).click();
  await expect(page.getByText(shopOrder.out_trade_no)).toBeVisible();
  await expect(page.getByText(unsigned.out_trade_no)).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "¥0.20" })).toBeVisible();
  await page.getByRole("link", { name: "API 对接" }).click();
  await expect(page.getByText(shopPid).first()).toBeVisible();
});

test("mobile navigation is usable and transfer checkout opens Alipay", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "Mobile-only assertion");
  await page.goto("/admin/login");
  await expect(page.getByRole("heading", { name: "管理员登录" })).toBeVisible();
  await page.getByLabel("用户名").fill("e2e-admin");
  await page.getByLabel("密码").fill("Test-password-2026");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "订单" })).toBeVisible();

  await page.getByRole("dialog").getByRole("link", { name: "商户管理", exact: true }).click();
  await page.getByRole("link", { name: "默认商户" }).click();
  await page.getByRole("button", { name: "查看凭据" }).click();
  const credentials = await page.getByRole("dialog").locator("textarea").inputValue();
  const pid = credentials.match(/PID=(\d+)/)?.[1] ?? "";
  const key = credentials.match(/KEY=([^\n]+)/)?.[1] ?? "";
  expect(pid).not.toBe("");
  expect(key).not.toBe("");
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "收款配置" }).click();
  await page.getByRole("button", { name: /转账备注/ }).click();
  await page.getByLabel("支付宝用户 ID").fill("2088000000000000");
  await page.getByLabel("转账链接包裹层级").selectOption("2");
  await page.getByRole("button", { name: /保存全部配置/ }).click({ force: true });
  await expect(page.getByText("配置已保存")).toBeVisible();

  await page.route("https://render.alipay.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<title>Alipay opened</title>" });
  });
  const unsigned = {
    pid,
    type: "alipay",
    out_trade_no: `MOBILE-${Date.now()}`,
    notify_url: "https://8.8.8.8/notify",
    return_url: "https://8.8.8.8/return",
    name: "Mobile transfer",
    money: "0.01",
    clientip: "203.0.113.10",
    sign_type: "MD5",
  };
  const fields = { ...unsigned, sign: md5(unsigned, key) };
  await page.evaluate((formFields) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/submit.php";
    for (const [name, value] of Object.entries(formFields)) {
      const input = document.createElement("input");
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, fields);

  await expect(page).toHaveURL(/^https:\/\/render\.alipay\.com\/p\/s\/i\?scheme=/);
  const transferScheme = new URL(page.url()).searchParams.get("scheme") ?? "";
  expect(transferScheme).toMatch(/^alipays:\/\/platformapi\/startapp\?appId=09999988/);
});

test("admin and merchant areas are isolated and merchants never see the admin login", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Runs once after the desktop setup flow.");
  const visitor = await (await browser.newContext()).newPage();
  for (const path of ["/", "/merchants", "/dashboard", "/login", "/payments", "/no-such-page"]) {
    await visitor.goto(path);
    await expect(visitor, `visiting ${path}`).toHaveURL(/\/merchant\/login$/);
    await expect(visitor.getByRole("heading", { name: "商户登录" })).toBeVisible();
    await expect(visitor.getByText(/admin|管理员/)).toHaveCount(0);
  }

  await visitor.goto("/admin/login");
  await expect(visitor.getByLabel("用户名")).toHaveValue("");
  await expect(visitor.getByText("admin", { exact: false })).toHaveCount(0);
  await visitor.getByLabel("用户名").fill("admin");
  await visitor.getByLabel("密码").fill("Test-password-2026");
  await visitor.getByRole("button", { name: /^登录/ }).click();
  await expect(visitor.getByText("用户名或密码错误")).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await admin.goto("/admin/login");
  await admin.getByLabel("用户名").fill("e2e-admin");
  await admin.getByLabel("密码").fill("Test-password-2026");
  await admin.getByRole("button", { name: /^登录/ }).click();
  await expect(admin).toHaveURL(/\/admin\/dashboard$/);
  await admin.goto("/payments"); // old Telegram alert links keep working for admins
  await expect(admin).toHaveURL(/\/admin\/payments$/);
  await admin.goto("/");
  await expect(admin).toHaveURL(/\/admin\/dashboard$/);

  const merchant = await (await browser.newContext()).newPage();
  await merchant.goto("/merchant/login");
  await merchant.getByLabel("用户名").fill("e2eshop");
  await merchant.getByLabel("密码").fill("e2e-shop-password");
  await merchant.getByRole("button", { name: /^登录/ }).click();
  await expect(merchant).toHaveURL(/\/merchant\/dashboard$/);
  await merchant.goto("/");
  await expect(merchant).toHaveURL(/\/merchant\/dashboard$/);
  await merchant.goto("/admin/dashboard");
  await expect(merchant).toHaveURL(/\/admin\/login$/);
  await merchant.goto("/merchant/orders");
  await expect(merchant.getByRole("heading", { name: "订单" })).toBeVisible();
});

test("admin blacklists a buyer IP and that buyer can no longer pay", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium");
  const admin = await (await browser.newContext()).newPage();
  await admin.goto("/admin/login");
  await admin.getByLabel("用户名").fill("e2e-admin");
  await admin.getByLabel("密码").fill("Test-password-2026");
  await admin.getByRole("button", { name: /^登录/ }).click();
  await expect(admin).toHaveURL(/\/admin\/dashboard$/);
  await admin.goto("/admin/settings");
  await admin.getByRole("button", { name: /经营码/ }).first().click();
  await admin.getByRole("button", { name: /保存全部配置/ }).click();
  await expect(admin.getByText("配置已保存")).toBeVisible();

  const csrf = (await admin.context().cookies()).find((c) => c.name === "alimpay_csrf")!.value;
  const merchants = await (await admin.request.get("/admin-api/merchants")).json() as { data: Array<{ id: string; name: string }> };
  const shop = merchants.data.find((m) => m.name === "E2E Shop")!;
  const creds = await (await admin.request.post(`/admin-api/merchants/${shop.id}/keys/v1/reveal`, { headers: { "x-csrf-token": csrf, origin: "http://127.0.0.1:3100" } })).json() as { pid: string; key: string };
  const order = (no: string, ip: string) => {
    const unsigned = { pid: creds.pid, type: "alipay", out_trade_no: no, notify_url: "https://8.8.8.8/notify", return_url: "https://8.8.8.8/return", name: "BL test", money: "2.34", clientip: ip, sign_type: "MD5" };
    return { ...unsigned, sign: md5(unsigned, creds.key) };
  };
  const first = await (await admin.request.post("/mapi.php", { form: order(`BL-${Date.now()}`, "198.51.100.23") })).json() as { code: number; payurl: string };
  expect(first.code).toBe(1);

  const buyer = await (await browser.newContext()).newPage();
  await buyer.goto(first.payurl);
  await expect(buyer.getByAltText("支付宝经营码")).toBeVisible();

  await admin.getByRole("link", { name: "黑名单" }).click();
  await admin.getByLabel("IP 或网段").fill("198.51.100.23");
  await admin.getByLabel("备注（可选）").fill("恶意投诉");
  await admin.getByRole("button", { name: "拉黑" }).click();
  await expect(admin.getByRole("cell", { name: "198.51.100.23" })).toBeVisible();

  await buyer.reload();
  await expect(buyer.getByRole("heading", { name: "无法完成支付" })).toBeVisible();
  await expect(buyer.getByAltText("支付宝经营码")).toHaveCount(0);

  const second = await (await admin.request.post("/mapi.php", { form: order(`BL2-${Date.now()}`, "198.51.100.23") })).json() as { code: number; msg: string };
  expect(second).toEqual({ code: -1, msg: "当前无法为您提供支付服务，请联系商家" });

  await admin.reload();
  await expect(admin.getByRole("row", { name: /198\.51\.100\.23/ }).getByRole("cell").nth(3)).toHaveText("2");
  await admin.goto("/admin/orders");
  await expect(admin.getByText("黑名单已拦截").first()).toBeVisible();
});
