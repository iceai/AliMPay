import { Ban, EyeOff, Link2, RotateCcw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import type { OrderRecord } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { StatusBadge } from "@/web/components/status-badge";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Loading } from "@/web/components/ui/loading";
import { cn, formatDate, formatMoney } from "@/web/lib/utils";
import { blacklistFrom } from "@/web/pages/blacklist";

export interface UnmatchedPayment {
  id: number;
  account_log_id: string;
  occurred_at: string;
  amount_cents: number;
  alipay_order_no: string | null;
  trans_memo: string | null;
  other_account: string | null;
  blacklist_id: string | null;
  ignored_at: string | null;
  suggestions: Array<OrderRecord & { amount_exact: boolean }>;
}

export async function linkPayment(payment: { id: number; amount_cents: number }, order: { reference: string; label: string; payable_amount_cents?: number }) {
  const mismatch = order.payable_amount_cents !== undefined && order.payable_amount_cents !== payment.amount_cents;
  const lines = [
    `把这笔 ${formatMoney(payment.amount_cents)} 的收款关联到订单「${order.label}」？`,
    "订单会标记为支付成功，并立即向商户网站发送回调通知。此操作不能撤销。",
  ];
  if (mismatch) lines.push("", `⚠️ 金额不一致：订单应付 ${formatMoney(order.payable_amount_cents!)}，实际收到 ${formatMoney(payment.amount_cents)}。`);
  if (!window.confirm(lines.join("\n"))) return false;
  try {
    await apiFetch(`/admin-api/payments/${payment.id}/link`, { method: "POST", ...jsonBody({ order: order.reference }) });
    toast.success("已关联，正在向商户网站发送通知");
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "关联失败");
    return false;
  }
}

function PaymentCard({ payment, ignoredView, refresh }: { payment: UnmatchedPayment; ignoredView: boolean; refresh: () => Promise<unknown> }) {
  const [reference, setReference] = useState("");

  async function linkManual(event: FormEvent) {
    event.preventDefault();
    if (!reference.trim()) return;
    if (await linkPayment(payment, { reference: reference.trim(), label: reference.trim() })) await refresh();
  }

  async function toggleIgnore() {
    try {
      await apiFetch(`/admin-api/payments/${payment.id}/ignore`, { method: "POST", ...jsonBody({ ignored: !ignoredView }) });
      toast.success(ignoredView ? "已恢复到待处理" : "已忽略");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-2xl font-semibold tracking-tight">{formatMoney(payment.amount_cents)}</div>
            <div className="mt-1 text-sm text-muted">{formatDate(payment.occurred_at)}{payment.other_account ? ` · ${payment.other_account}` : ""}</div>
            {payment.blacklist_id ? <Badge variant="danger" className="mt-2">黑名单付款人 · 已拦截，未确认任何订单</Badge> : null}
            {payment.trans_memo ? <div className="mt-1 text-sm">备注：{payment.trans_memo}</div> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {payment.other_account && !payment.blacklist_id ? <Button variant="ghost" size="sm" onClick={async () => {
              if (await blacklistFrom(`/admin-api/payments/${payment.id}/blacklist`, `拉黑付款人 ${payment.other_account}`)) await refresh();
            }}><Ban />拉黑付款人</Button> : null}
            <Button variant="ghost" size="sm" onClick={toggleIgnore}>{ignoredView ? <><RotateCcw />恢复</> : <><EyeOff />忽略（与订单无关）</>}</Button>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium text-muted">可能对应的未支付订单</div>
          {payment.suggestions.length === 0 ? <div className="rounded-md border border-dashed p-3 text-sm text-muted">没有找到金额相近的未支付订单（24 小时内、相差不超过 1 元）</div> : payment.suggestions.map((order) => (
            <div key={order.id} className={cn("flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between", order.amount_exact && "border-success/40 bg-success/5")}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/admin/orders/${order.id}`} className="truncate font-medium hover:text-primary">{order.name}</Link>
                  <StatusBadge status={order.status} />
                  {order.amount_exact ? <Badge variant="success">金额一致</Badge> : <Badge variant="danger">应付 {formatMoney(order.payable_amount_cents)}</Badge>}
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted">{order.out_trade_no} · 创建于 {formatDate(order.created_at)}</div>
              </div>
              <Button size="sm" className="shrink-0" onClick={async () => {
                if (await linkPayment(payment, { reference: order.id, label: `${order.name} / ${order.out_trade_no}`, payable_amount_cents: order.payable_amount_cents })) await refresh();
              }}><Link2 />关联并通知</Button>
            </div>
          ))}
        </div>

        <form className="mt-3 flex gap-2" onSubmit={linkManual}>
          <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="其他订单：填写平台订单号或商户订单号" aria-label="要关联的订单号" />
          <Button type="submit" variant="outline" disabled={!reference.trim()}>关联</Button>
        </form>
        <div className="mt-3 break-all font-mono text-[11px] text-muted">支付宝流水号 {payment.account_log_id}</div>
      </CardContent>
    </Card>
  );
}

export function PaymentsPage() {
  const [view, setView] = useState<"pending" | "ignored">("pending");
  const { data, isLoading, mutate } = useSWR<{ data: UnmatchedPayment[]; unmatched_count: number }>(`/admin-api/payments?view=${view}`, swrFetcher, { refreshInterval: 10_000 });

  return (
    <>
      <PageHeader
        title="未匹配收款"
        description="支付宝收到了钱，但没能自动对上订单（金额付错、超时付款等）。核对后一键关联，系统会把订单改为支付成功并通知商户网站。"
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant={view === "pending" ? "default" : "outline"} size="sm" onClick={() => setView("pending")}>待处理{data && view === "pending" ? ` (${data.unmatched_count})` : ""}</Button>
        <Button variant={view === "ignored" ? "default" : "outline"} size="sm" onClick={() => setView("ignored")}>已忽略</Button>
        {view === "pending" && data && data.unmatched_count > 0 ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={async () => {
            if (!window.confirm(`确定忽略全部 ${data.unmatched_count} 笔待处理收款？\n忽略后不再提醒，需要时可在“已忽略”里逐条恢复或关联。`)) return;
            try {
              const result = await apiFetch<{ ignored: number }>("/admin-api/payments/ignore-all", { method: "POST" });
              toast.success(`已忽略 ${result.ignored} 笔`);
              await mutate();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "操作失败");
            }
          }}><EyeOff />全部忽略</Button>
        ) : null}
      </div>
      {isLoading || !data ? <Loading /> : data.data.length === 0 ? (
        <Card><CardContent className="py-16 text-center text-sm text-muted">{view === "pending" ? "没有待处理的收款，一切正常" : "没有已忽略的收款"}</CardContent></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {data.data.map((payment) => <PaymentCard key={payment.id} payment={payment} ignoredView={view === "ignored"} refresh={mutate} />)}
        </div>
      )}
    </>
  );
}
