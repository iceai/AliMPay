import { Plus, Store } from "lucide-react";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import type { MerchantBalance, MerchantStats, MerchantSummary } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { MerchantStatsGrid } from "@/web/components/merchant-stats";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { DisclosureDialog, type KeyDisclosure } from "@/web/pages/keys";
import { formatDate, formatMoney } from "@/web/lib/utils";

interface MerchantsResponse {
  data: Array<MerchantSummary & { balance: MerchantBalance }>;
  totals: MerchantStats;
}

function CreateMerchantDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: { merchant: MerchantSummary; pid: string; key: string }) => void;
}) {
  const [form, setForm] = useState({ name: "", username: "", password: "", fee_rate: "0", remark: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) => setForm((value) => ({ ...value, [key]: event.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const result = await apiFetch<{ merchant: MerchantSummary; pid: string; key: string }>("/admin-api/merchants", { method: "POST", ...jsonBody(form) });
      setForm({ name: "", username: "", password: "", fee_rate: "0", remark: "" });
      onCreated(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>新建商户</DialogTitle>
        <DialogDescription>系统自动生成商户 PID 与 V1 MD5 key。所有商户共用平台配置的收款码。</DialogDescription>
        <form className="mt-4 space-y-4" onSubmit={submit}>
          <div className="space-y-2"><Label htmlFor="m-name">商户名称</Label><Input id="m-name" value={form.name} onChange={set("name")} required maxLength={64} autoFocus /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="m-user">后台登录用户名</Label><Input id="m-user" value={form.username} onChange={set("username")} placeholder="留空则不开通后台" autoComplete="off" /></div>
            <div className="space-y-2"><Label htmlFor="m-pass">后台登录密码</Label><Input id="m-pass" type="password" value={form.password} onChange={set("password")} placeholder="至少 8 位" autoComplete="new-password" /></div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="m-fee">手续费（%）</Label>
            <Input id="m-fee" inputMode="decimal" value={form.fee_rate} onChange={set("fee_rate")} required />
            <p className="text-xs text-muted">按订单金额收取，最多两位小数，例如 0.6 表示 0.6%。修改费率只影响之后创建的订单。</p>
          </div>
          <div className="space-y-2"><Label htmlFor="m-remark">备注</Label><Input id="m-remark" value={form.remark} onChange={set("remark")} maxLength={500} /></div>
          {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button disabled={saving}>{saving ? "正在创建…" : "创建商户"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MerchantsPage() {
  const navigate = useNavigate();
  const { data, isLoading, mutate } = useSWR<MerchantsResponse>("/admin-api/merchants", swrFetcher, { refreshInterval: 15_000 });
  const [creating, setCreating] = useState(false);
  const [disclosure, setDisclosure] = useState<KeyDisclosure | null>(null);
  if (isLoading || !data) return <Loading label="正在读取商户" />;

  return (
    <>
      <PageHeader
        title="商户管理"
        description="每个商户拥有独立的 PID 与接口密钥、独立的手续费率和商户后台；收款统一使用平台配置的收款码。"
        actions={<Button onClick={() => setCreating(true)}><Plus />新建商户</Button>}
      />

      <h2 className="mb-3 text-sm font-medium text-muted">全部商户合计</h2>
      <MerchantStatsGrid stats={data.totals} />

      <Card className="mt-6">
        <CardHeader><CardTitle>商户列表</CardTitle><CardDescription>共 {data.data.length} 个商户。商户后台地址：<code className="font-mono">{window.location.origin}/merchant/login</code></CardDescription></CardHeader>
        <CardContent>
          {data.data.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted"><Store className="size-6" />还没有商户<Button size="sm" onClick={() => setCreating(true)}><Plus />新建商户</Button></div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead className="border-b text-xs text-muted">
                  <tr><th className="pb-3 font-medium">商户</th><th className="pb-3 font-medium">PID</th><th className="pb-3 font-medium">费率</th><th className="pb-3 font-medium">后台登录</th><th className="pb-3 font-medium">今日实收</th><th className="pb-3 font-medium">累计实收</th><th className="pb-3 font-medium">累计手续费</th><th className="pb-3 font-medium">可用余额</th><th className="pb-3 font-medium">冻结</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">创建时间</th></tr>
                </thead>
                <tbody className="divide-y">
                  {data.data.map((merchant) => (
                    <tr key={merchant.id} className="cursor-pointer hover:bg-foreground/[0.025]" onClick={() => navigate(`/merchants/${merchant.id}`)}>
                      <td className="py-3"><Link className="font-medium hover:text-primary" to={`/merchants/${merchant.id}`} onClick={(event) => event.stopPropagation()}>{merchant.name}</Link>{merchant.remark ? <div className="max-w-48 truncate text-xs text-muted">{merchant.remark}</div> : null}</td>
                      <td className="py-3 font-mono text-xs">{merchant.pid}</td>
                      <td className="py-3 font-mono">{merchant.fee_rate}%</td>
                      <td className="py-3">{merchant.login_enabled ? <span className="font-mono text-xs">{merchant.username}</span> : <span className="text-xs text-muted">未开通</span>}</td>
                      <td className="py-3 font-mono">{formatMoney(merchant.stats?.today.paid_cents ?? 0)}</td>
                      <td className="py-3 font-mono">{formatMoney(merchant.stats?.total.paid_cents ?? 0)}</td>
                      <td className="py-3 font-mono">{formatMoney(merchant.stats?.total.fee_cents ?? 0)}</td>
                      <td className="py-3 font-mono font-medium">{formatMoney(merchant.balance.available_cents)}</td>
                      <td className="py-3 font-mono text-muted">{formatMoney(merchant.balance.frozen_cents)}</td>
                      <td className="py-3"><Badge variant={merchant.status === "active" ? "success" : "danger"}>{merchant.status === "active" ? "正常" : "已禁用"}</Badge></td>
                      <td className="py-3 text-right text-xs text-muted">{formatDate(merchant.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateMerchantDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (result) => {
          setCreating(false);
          toast.success(`商户“${result.merchant.name}”已创建`);
          setDisclosure({
            title: "新商户的接口凭据",
            privateKey: `PID=${result.pid}\nKEY=${result.key}`,
            privateKeyLabel: "V1 PID 与 MD5 key",
            privateKeyHelp: "可随时在商户详情或商户后台再次查看。V2 RSA 商户密钥可在商户详情中生成或导入。",
            privateKeyFilename: `v1-credentials-${result.pid}.txt`,
          });
          await mutate();
        }}
      />
      <DisclosureDialog value={disclosure} onClose={() => setDisclosure(null)} />
    </>
  );
}
