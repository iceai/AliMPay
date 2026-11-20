import { CheckCircle2, Clock3, ExternalLink, TriangleAlert } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import useSWR from "swr";
import { PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS, type CheckoutData } from "@/shared/contracts";
import { apiFetch, swrFetcher } from "@/web/api";
import { CopyButton } from "@/web/components/copy-button";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent } from "@/web/components/ui/card";
import { Loading } from "@/web/components/ui/loading";
import { formatDate } from "@/web/lib/utils";

function countdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

type CheckoutState = "pending" | "paid" | "notified";

function checkoutState(data: CheckoutData): CheckoutState {
  if (data.status !== "paid" && data.status !== "late_paid") return "pending";
  return data.notify_delivered ? "notified" : "paid";
}

/** Once paid, wait at most this long for the merchant to acknowledge the notification before returning anyway. */
const MAX_WAIT_FOR_NOTIFY_MS = 5_000;
/** Brief pause so the customer sees the success state before leaving. */
const REDIRECT_DELAY_MS = 800;

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function isMobileBrowser() {
  const browserNavigator = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (browserNavigator.userAgentData?.mobile === true) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(browserNavigator.userAgent) ||
    (/Macintosh/i.test(browserNavigator.userAgent) && browserNavigator.maxTouchPoints > 1);
}

export function CheckoutPage() {
  const { token = "" } = useParams();
  const [now, setNow] = useState(Date.now());
  const mobileRedirectAttempted = useRef(false);
  const checkoutPath = `/public-api/checkout/${encodeURIComponent(token)}`;
  const { data, error, isLoading, mutate } = useSWR<CheckoutData>(checkoutPath, swrFetcher, {
    refreshInterval: (latest) => {
      if (latest && (latest.blocked || ["paid", "late_paid"].includes(latest.status) || Date.parse(latest.monitor_until) <= Date.now())) return 0;
      return (latest?.payment_poll_interval_seconds ?? PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS) * 1_000;
    },
    shouldRetryOnError: false,
  });
  const { data: generatedQr } = useSWR(
    data?.collection_mode === "transfer" && data.payment_uri ? ["transfer-qr", data.payment_uri] : null,
    ([, uri]) => QRCode.toDataURL(uri, { width: 300, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0f172a", light: "#f8fafc" } }),
  );

  const latest = useRef<CheckoutData | undefined>(undefined);
  latest.current = data;
  const [paidSeenAt, setPaidSeenAt] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Long-poll so the page learns about the payment the moment the server matches it,
  // instead of waiting for the next polling interval. Interval polling stays as a fallback.
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    void (async () => {
      while (!stopped) {
        const current = latest.current;
        if (!current) { await sleep(300); continue; }
        const state = checkoutState(current);
        if (current.blocked || state === "notified") return;
        if (state === "paid" && !current.return_target) return;
        if (state === "pending" && Date.parse(current.monitor_until) <= Date.now()) return;
        try {
          const next = await apiFetch<CheckoutData>(`${checkoutPath}/wait?since=${state}`, { signal: controller.signal });
          latest.current = next;
          await mutate(next, { revalidate: false });
        } catch {
          if (stopped) return;
          await sleep(2_000);
        }
      }
    })();
    return () => { stopped = true; controller.abort(); };
  }, [checkoutPath, mutate]);

  // Mobile browsers pause timers while the customer is in the Alipay app; refresh as soon as they come back.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void mutate(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [mutate]);

  const isPaid = data?.status === "paid" || data?.status === "late_paid";
  const returnTarget = data?.return_target ?? null;
  const notifyDelivered = data?.notify_delivered ?? false;
  useEffect(() => {
    if (isPaid && paidSeenAt === null) setPaidSeenAt(Date.now());
  }, [isPaid, paidSeenAt]);

  // Return to the merchant's order (card key) page automatically. Prefer waiting until the merchant
  // has acknowledged the notification so that page already shows the delivered goods.
  const redirectAt = isPaid && returnTarget && paidSeenAt !== null
    ? (notifyDelivered ? paidSeenAt + REDIRECT_DELAY_MS : paidSeenAt + MAX_WAIT_FOR_NOTIFY_MS)
    : null;
  useEffect(() => {
    if (redirectAt === null || !returnTarget) return;
    const timer = window.setTimeout(() => window.location.replace(returnTarget), Math.max(0, redirectAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [redirectAt, returnTarget]);

  useEffect(() => {
    if (
      mobileRedirectAttempted.current ||
      !data ||
      data.collection_mode !== "transfer" ||
      data.status !== "pending" ||
      !data.payment_uri ||
      Date.parse(data.expires_at) <= Date.now() ||
      !isMobileBrowser()
    ) return;

    mobileRedirectAttempted.current = true;
    window.location.assign(data.payment_uri);
  }, [data]);

  if (isLoading) return <Loading label="正在读取支付订单" />;
  if (error || !data) return <main className="flex min-h-screen items-center justify-center px-4"><div className="max-w-sm text-center"><TriangleAlert className="mx-auto size-9 text-destructive" /><h1 className="mt-4 text-xl font-semibold">订单不存在</h1><p className="mt-2 text-sm text-muted">链接可能无效，或订单信息无法读取。</p></div></main>;

  const paid = data.status === "paid" || data.status === "late_paid";
  if (data.blocked) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md"><CardContent className="px-6 py-10 text-center"><TriangleAlert className="mx-auto size-10 text-destructive" /><h1 className="mt-4 text-xl font-semibold">无法完成支付</h1><p className="mt-2 text-sm leading-6 text-muted">当前无法为您提供支付服务，请联系商家。</p><div className="mt-6 rounded-md border p-3 text-left text-xs text-muted">订单号：<span className="font-mono text-foreground">{data.out_trade_no}</span></div></CardContent></Card>
      </main>
    );
  }
  const checkoutExpired = now >= Date.parse(data.expires_at);
  const monitoringEnded = now >= Date.parse(data.monitor_until);

  if (paid) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md"><CardContent className="px-6 py-10 text-center"><CheckCircle2 className="mx-auto size-12 text-success" /><Badge className="mt-5" variant={data.status === "late_paid" ? "primary" : "success"}>{data.status === "late_paid" ? "迟到支付已确认" : "支付成功"}</Badge><h1 className="mt-4 text-2xl font-semibold tracking-tight">已收到 ¥{data.payable_money}</h1><p className="mt-2 text-sm text-muted">订单 {data.out_trade_no} 已完成{data.notify_delivered ? "，商户已确认收款。" : "，正在通知商户…"}</p>{data.return_target ? <><p className="mt-4 text-sm font-medium text-primary" role="status">{redirectAt !== null && redirectAt - now > 1_000 ? `${Math.ceil((redirectAt - now) / 1_000)} 秒后自动返回商户页面…` : "正在返回商户页面…"}</p><Button className="mt-4 w-full" asChild><a href={data.return_target}>立即返回商户页面<ExternalLink /></a></Button></> : null}<p className="mt-5 text-xs text-muted">支付结果以商户服务器验签后的异步通知为准。</p></CardContent></Card>
      </main>
    );
  }

  if (monitoringEnded) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12"><Card className="w-full max-w-md"><CardContent className="px-6 py-10 text-center"><Clock3 className="mx-auto size-10 text-destructive" /><h1 className="mt-4 text-xl font-semibold">订单确认窗口已结束</h1><p className="mt-2 text-sm leading-6 text-muted">系统未在 10 分钟内匹配到支付。请不要继续付款，并返回商户重新创建订单。</p><div className="mt-6 rounded-md border p-3 text-left text-xs text-muted">商户订单号：<span className="font-mono text-foreground">{data.out_trade_no}</span></div></CardContent></Card></main>
    );
  }

  const businessQr = data.collection_mode === "business_qr";

  return (
    <main className="min-h-screen px-4 py-6 sm:py-10">
      <Card className="mx-auto w-full max-w-md">
        <CardContent className="px-5 py-6 text-center sm:px-7">
          <p className="truncate text-sm text-muted">{data.name}</p>
          <h1 className="mt-2 font-mono text-5xl font-bold tracking-tight text-primary sm:text-6xl">¥{data.payable_money}</h1>
          {businessQr ? <CopyButton value={data.payable_money} label="复制金额" variant="default" size="lg" className="mt-4 h-11 w-full text-base" /> : null}

          <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-left text-sm font-semibold leading-6 text-destructive">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" />
            <p>{businessQr ? `请输入准确金额 ${data.payable_money} 元，否则无法自动到账` : `请勿修改金额和备注，否则无法自动到账`}</p>
          </div>

          <div className="mt-5 flex items-center justify-center rounded-lg border p-4">
            {businessQr ? <img src={data.business_qr_url} alt="支付宝经营码" className="max-h-[280px] max-w-full object-contain" /> : generatedQr ? <img src={generatedQr} alt="支付宝转账二维码" className="size-[260px] max-w-full object-contain" /> : <Loading label="正在生成二维码" />}
          </div>
          {!businessQr && data.payment_uri ? <Button className="mt-4 w-full md:hidden" asChild><a href={data.payment_uri}>打开支付宝<ExternalLink /></a></Button> : null}

          <p className="mt-4 text-sm text-muted">{businessQr ? "支付宝扫码 → 输入上方金额 → 付款" : "支付宝扫码 → 确认付款"}</p>
          {checkoutExpired
            ? <p className="mt-3 text-xs leading-5 text-muted">已超过支付时间。已付款请稍候，系统会继续确认到 {formatDate(data.monitor_until)}；未付款请返回重新下单。</p>
            : <p className="mt-3 font-mono text-xs text-muted">剩余 {countdown(Date.parse(data.expires_at) - now)} · 付款后本页自动确认</p>}
          <p className="mt-4 break-all font-mono text-[11px] text-muted/70">订单号 {data.out_trade_no}</p>
        </CardContent>
      </Card>
    </main>
  );
}
