import { ArrowLeft, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import useSWR from "swr";
import type { ApiVersion, MerchantStats, MerchantSummary, OrderStatus } from "@/shared/contracts";
import { swrFetcher } from "@/web/api";
import { MerchantStatsGrid } from "@/web/components/merchant-stats";
import { PageHeader } from "@/web/components/page-header";
import { StatusBadge } from "@/web/components/status-badge";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Loading } from "@/web/components/ui/loading";
import { formatDate, formatMoney } from "@/web/lib/utils";

/** The order fields the merchant API exposes. */
export interface MerchantOrder {
  id: string;
  trade_no: string;
  out_trade_no: string;
  api_version: ApiVersion;
  name: string;
  requested_amount_cents: number;
  payable_amount_cents: number;
  fee_rate_bp: number;
  fee_cents: number;
  status: OrderStatus;
  notify_url: string;
  return_url: string | null;
  param: string;
  client_ip: string;
  buyer: string;
  alipay_order_no: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
}

function OrdersTable({ orders }: { orders: MerchantOrder[] }) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="border-b text-xs text-muted">
          <tr><th className="pb-3 font-medium">平台订单号</th><th className="pb-3 font-medium">商户订单号</th><th className="pb-3 font-medium">商品</th><th className="pb-3 font-medium">金额</th><th className="pb-3 font-medium">手续费</th><th className="pb-3 font-medium">应得</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">创建时间</th></tr>
        </thead>
        <tbody className="divide-y">
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-foreground/[0.025]">
              <td className="py-3 font-mono text-xs"><Link className="hover:text-primary" to={`/merchant/orders/${order.id}`}>{order.trade_no}</Link></td>
              <td className="py-3 font-mono text-xs">{order.out_trade_no}</td>
              <td className="max-w-40 truncate py-3">{order.name}</td>
              <td className="py-3 font-mono">{formatMoney(order.requested_amount_cents)}</td>
              <td className="py-3 font-mono text-muted">{formatMoney(order.fee_cents)}</td>
              <td className="py-3 font-mono">{formatMoney(order.requested_amount_cents - order.fee_cents)}</td>
              <td className="py-3"><StatusBadge status={order.status} /></td>
              <td className="py-3 text-right text-xs text-muted">{formatDate(order.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MerchantDashboardPage() {
  const { data, isLoading } = useSWR<{ merchant: MerchantSummary; stats: MerchantStats; recent_orders: MerchantOrder[] }>("/merchant-api/dashboard", swrFetcher, { refreshInterval: 10_000 });
  if (isLoading || !data) return <Loading label="正在汇总数据" />;
  return (
    <>
      <PageHeader title="数据概览" description={`当前手续费率 ${data.merchant.fee_rate}%。金额按下单金额统计，“应得”为扣除手续费后的金额。`} />
      <MerchantStatsGrid stats={data.stats} />
      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between">
          <div><CardTitle>最近订单</CardTitle><CardDescription>每 10 秒刷新一次。</CardDescription></div>
          <Button asChild variant="ghost" size="sm"><Link to="/merchant/orders">查看全部</Link></Button>
        </CardHeader>
        <CardContent>
          {data.recent_orders.length === 0
            ? <div className="py-12 text-center text-sm text-muted">还没有订单，可在“API 对接”中查看接入方式</div>
            : <OrdersTable orders={data.recent_orders} />}
        </CardContent>
      </Card>
    </>
  );
}

export function MerchantOrdersPage() {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [page, setPage] = useState(1);
  const path = `/merchant-api/orders?page=${page}&limit=20&status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}`;
  const { data, isLoading } = useSWR<{ data: MerchantOrder[]; total: number }>(path, swrFetcher, { refreshInterval: 10_000 });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20));

  function search(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQuery(queryInput.trim());
  }

  return (
    <>
      <PageHeader title="订单" description="本商户的全部订单与支付状态。" />
      <Card>
        <CardContent className="pt-5">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row">
            <form className="flex flex-1 gap-2" onSubmit={search}>
              <Input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="平台订单号、商户订单号或商品名称" aria-label="搜索订单" />
              <Button type="submit" variant="outline"><Search />搜索</Button>
            </form>
            <select className="h-9 rounded-md border bg-transparent px-3 text-sm" value={status} onChange={(event) => { setStatus(event.target.value as OrderStatus | ""); setPage(1); }} aria-label="订单状态">
              <option value="">全部状态</option><option value="pending">等待支付</option><option value="expired">已过期</option><option value="paid">支付成功</option><option value="late_paid">迟到支付</option>
            </select>
          </div>
          {isLoading ? <Loading /> : !data?.data.length ? <div className="py-16 text-center text-sm text-muted">没有符合条件的订单</div> : <OrdersTable orders={data.data} />}
          <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm text-muted">
            <span>共 {data?.total ?? 0} 笔</span>
            <div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft /></Button><span className="min-w-16 text-center">{page} / {pages}</span><Button variant="outline" size="icon" aria-label="下一页" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight /></Button></div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt className="text-xs text-muted">{label}</dt><dd className={`mt-1 break-all text-sm ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd></div>;
}

interface NotificationRow {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_http_status: number | null;
  last_error: string | null;
  manual: number;
  created_at: string;
  updated_at: string;
}

const notifyLabels: Record<string, string> = { pending: "等待发送", processing: "发送中", succeeded: "已送达", failed: "失败" };

export function MerchantOrderDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading } = useSWR<{ order: MerchantOrder; notifications: NotificationRow[] }>(`/merchant-api/orders/${id}`, swrFetcher, { refreshInterval: 10_000 });
  if (isLoading || !data) return <Loading label="正在读取订单" />;
  const { order } = data;
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2"><Link to="/merchant/orders"><ArrowLeft />订单列表</Link></Button>
      <PageHeader title={order.name} description={`商户订单号 ${order.out_trade_no}`} actions={<StatusBadge status={order.status} />} />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card className="min-w-0">
          <CardHeader><CardTitle>订单信息</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field label="订单金额" value={formatMoney(order.requested_amount_cents)} /><Field label="客户实付" value={formatMoney(order.payable_amount_cents)} />
              <Field label="手续费" value={`${formatMoney(order.fee_cents)}（${order.fee_rate_bp / 100}%）`} /><Field label="商户应得" value={formatMoney(order.requested_amount_cents - order.fee_cents)} />
              <Field label="平台订单号" value={order.trade_no} mono /><Field label="支付宝订单号" value={order.alipay_order_no ?? ""} mono />
              <Field label="协议版本" value={order.api_version.toUpperCase()} /><Field label="客户端 IP" value={order.client_ip} mono />
              <Field label="创建时间" value={formatDate(order.created_at)} /><Field label="支付时间" value={formatDate(order.paid_at)} />
              <Field label="回调地址" value={order.notify_url} mono /><Field label="同步返回地址" value={order.return_url ?? ""} mono />
              <Field label="附加参数 param" value={order.param} mono /><Field label="付款方" value={order.buyer} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>异步通知</CardTitle><CardDescription>支付成功后向回调地址发送 GET 通知，失败每 60 秒重试，最多 10 次。</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {data.notifications.length === 0 ? <div className="py-6 text-center text-sm text-muted">暂无通知记录</div> : data.notifications.map((job) => (
              <div key={job.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between"><Badge variant={job.status === "succeeded" ? "success" : job.status === "failed" ? "danger" : "outline"}>{notifyLabels[job.status] ?? job.status}</Badge><span className="text-xs text-muted">{job.attempts} / {job.max_attempts} 次</span></div>
                <div className="mt-2 text-xs text-muted">更新于 {formatDate(job.updated_at)}{job.last_http_status ? ` · HTTP ${job.last_http_status}` : ""}</div>
                {job.last_error ? <div className="mt-2 break-all text-xs text-destructive">{job.last_error}</div> : null}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
