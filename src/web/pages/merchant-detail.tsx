import { ArrowLeft, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import type { MerchantBalance, MerchantSummary, OrderRecord, WithdrawalRecord } from "@/shared/contracts";
import { BalanceCards, WithdrawalStatusBadge } from "@/web/components/withdrawal-parts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { MerchantKeysPanel } from "@/web/components/merchant-keys";
import { MerchantStatsGrid } from "@/web/components/merchant-stats";
import { PageHeader } from "@/web/components/page-header";
import { StatusBadge } from "@/web/components/status-badge";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { Switch } from "@/web/components/ui/switch";
import { ConfirmationDialog, type Confirmation } from "@/web/pages/keys";
import { formatDate, formatMoney } from "@/web/lib/utils";

interface DetailResponse {
  merchant: MerchantSummary;
  balance: MerchantBalance;
  recent_orders: OrderRecord[];
  recent_withdrawals: WithdrawalRecord[];
}

function ProfileForm({ merchant, onSaved }: { merchant: MerchantSummary; onSaved: () => unknown }) {
  const [form, setForm] = useState({ name: "", username: "", password: "", fee_rate: "0", remark: "", active: true });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setForm({ name: merchant.name, username: merchant.username ?? "", password: "", fee_rate: merchant.fee_rate, remark: merchant.remark, active: merchant.status === "active" });
  }, [merchant]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch(`/admin-api/merchants/${merchant.id}`, {
        method: "PUT",
        ...jsonBody({
          name: form.name,
          username: form.username.trim() || null,
          ...(form.password ? { password: form.password } : {}),
          fee_rate: form.fee_rate,
          remark: form.remark,
          status: form.active ? "active" : "disabled",
        }),
      });
      toast.success("商户信息已保存");
      setForm((value) => ({ ...value, password: "" }));
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>商户资料</CardTitle><CardDescription>修改费率只影响之后创建的订单；已有订单保留下单时的费率。</CardDescription></CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2"><Label htmlFor="md-name">商户名称</Label><Input id="md-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={64} /></div>
          <div className="space-y-2">
            <Label htmlFor="md-fee">手续费（%）</Label>
            <Input id="md-fee" inputMode="decimal" value={form.fee_rate} onChange={(event) => setForm({ ...form, fee_rate: event.target.value })} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="md-user">后台登录用户名</Label><Input id="md-user" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="留空则关闭商户后台" autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="md-pass">{merchant.login_enabled ? "重置登录密码" : "设置登录密码"}</Label><Input id="md-pass" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={merchant.login_enabled ? "留空则不修改" : "至少 8 位"} autoComplete="new-password" /></div>
          </div>
          <div className="space-y-2"><Label htmlFor="md-remark">备注</Label><Input id="md-remark" value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} maxLength={500} /></div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div><div className="text-sm font-medium">启用商户</div><p className="text-xs text-muted">禁用后接口下单、查询和商户后台登录都会被拒绝，已登录会话立即失效。</p></div>
            <Switch checked={form.active} onCheckedChange={(checked) => setForm({ ...form, active: checked })} aria-label="启用商户" />
          </div>
          <Button disabled={saving}><Save />{saving ? "正在保存…" : "保存"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function MerchantDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, mutate } = useSWR<DetailResponse>(`/admin-api/merchants/${id}`, swrFetcher);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  if (isLoading || !data) return <Loading label="正在读取商户" />;
  const { merchant } = data;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2"><Link to="/merchants"><ArrowLeft />商户列表</Link></Button>
      <PageHeader
        title={merchant.name}
        description={`PID ${merchant.pid} · 手续费 ${merchant.fee_rate}% · 创建于 ${formatDate(merchant.created_at)}`}
        actions={<>
          <Badge variant={merchant.status === "active" ? "success" : "danger"}>{merchant.status === "active" ? "正常" : "已禁用"}</Badge>
          <Button variant="outline" asChild><Link to={`/orders?pid=${merchant.pid}`}>查看全部订单</Link></Button>
          <Button variant="danger" onClick={() => setConfirmation({
            title: "删除商户",
            description: "只能删除没有任何订单的商户；已有订单的商户请改为禁用。此操作不可撤销。",
            confirmLabel: "确认删除",
            action: async () => {
              try {
                await apiFetch(`/admin-api/merchants/${merchant.id}`, { method: "DELETE" });
                toast.success("商户已删除");
                navigate("/merchants", { replace: true });
              } catch (error) { toast.error(error instanceof Error ? error.message : "删除失败"); }
            },
          })}><Trash2 />删除</Button>
        </>}
      />

      <MerchantStatsGrid stats={merchant.stats!} />
      <h2 className="mb-3 mt-6 text-sm font-medium text-muted">余额</h2>
      <BalanceCards balance={data.balance} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[420px_1fr]">
        <ProfileForm merchant={merchant} onSaved={mutate} />
        <Card className="min-w-0">
          <CardHeader><CardTitle>最近订单</CardTitle></CardHeader>
          <CardContent>
            {data.recent_orders.length === 0 ? <div className="py-12 text-center text-sm text-muted">该商户还没有订单</div> : (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="border-b text-xs text-muted"><tr><th className="pb-3 font-medium">商户订单号</th><th className="pb-3 font-medium">金额</th><th className="pb-3 font-medium">手续费</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">创建时间</th></tr></thead>
                  <tbody className="divide-y">
                    {data.recent_orders.map((order) => (
                      <tr key={order.id}>
                        <td className="py-3 font-mono text-xs"><Link className="hover:text-primary" to={`/orders/${order.id}`}>{order.out_trade_no}</Link></td>
                        <td className="py-3 font-mono">{formatMoney(order.requested_amount_cents)}</td>
                        <td className="py-3 font-mono text-muted">{formatMoney(order.fee_cents)}</td>
                        <td className="py-3"><StatusBadge status={order.status} /></td>
                        <td className="py-3 text-right text-xs text-muted">{formatDate(order.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader className="flex-row items-center justify-between"><CardTitle>最近提现</CardTitle><Button asChild variant="ghost" size="sm"><Link to="/withdrawals">提现管理</Link></Button></CardHeader>
        <CardContent>
          {data.recent_withdrawals.length === 0 ? <div className="py-8 text-center text-sm text-muted">暂无提现记录</div> : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b text-xs text-muted"><tr><th className="pb-3 font-medium">申请单号</th><th className="pb-3 font-medium">打款金额</th><th className="pb-3 font-medium">手续费</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">申请时间</th></tr></thead>
                <tbody className="divide-y">
                  {data.recent_withdrawals.map((withdrawal) => (
                    <tr key={withdrawal.id}>
                      <td className="py-3 font-mono text-xs">{withdrawal.withdraw_no}</td>
                      <td className="py-3 font-mono">{formatMoney(withdrawal.amount_cents)}</td>
                      <td className="py-3 font-mono text-muted">{formatMoney(withdrawal.fee_cents)}</td>
                      <td className="py-3"><WithdrawalStatusBadge status={withdrawal.status} /></td>
                      <td className="py-3 text-right text-xs text-muted">{formatDate(withdrawal.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <h2 className="mb-3 mt-8 text-base font-semibold">接口密钥</h2>
      <MerchantKeysPanel base={`/admin-api/merchants/${merchant.id}`} merchant={merchant} onChange={mutate} />
      <ConfirmationDialog value={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}
