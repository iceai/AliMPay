import { Ban, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type { BlacklistEntry, BlacklistKind } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { ConfirmationDialog, type Confirmation } from "@/web/pages/keys";
import { formatDate } from "@/web/lib/utils";

const kindLabels: Record<BlacklistKind, string> = { ip: "IP", alipay_account: "支付宝账号" };

/** Adds blacklist entries from an order or a payment; returns false on failure. */
export async function blacklistFrom(path: string, description: string) {
  if (!window.confirm(`${description}\n\n拉黑后：该 IP 无法再下单、打开收银台也看不到收款码；该支付宝账号付款不会确认任何订单。`)) return false;
  try {
    const result = await apiFetch<{ added: BlacklistEntry[] }>(path, { method: "POST", ...jsonBody({}) });
    toast.success(`已拉黑：${result.added.map((entry) => entry.value).join("、")}`);
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "拉黑失败");
    return false;
  }
}

export function BlacklistPage() {
  const { data, isLoading, mutate } = useSWR<{ data: BlacklistEntry[] }>("/admin-api/blacklist", swrFetcher);
  const [form, setForm] = useState<{ kind: BlacklistKind; value: string; note: string }>({ kind: "ip", value: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await apiFetch<{ entry: BlacklistEntry; created: boolean }>("/admin-api/blacklist", { method: "POST", ...jsonBody(form) });
      toast.success(result.created ? `已拉黑 ${result.entry.value}` : `${result.entry.value} 已在黑名单中`);
      setForm({ ...form, value: "", note: "" });
      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="黑名单" description="被拉黑的人无法完成付款：所有商户通用。也可以在订单详情或未匹配收款里一键拉黑。" />

      <div className="mb-6 grid gap-4 text-sm md:grid-cols-2">
        <div className="rounded-lg border p-4"><div className="font-medium">IP</div><p className="mt-1 leading-6 text-muted">下单时直接拒绝；已打开的收银台立即隐藏收款码，订单被锁定、永远不会确认支付。支持 1.2.3.4、1.2.3.0/24；手机 IPv6 地址会经常变化，建议按 /64 拉黑（一键拉黑会自动处理）。</p></div>
        <div className="rounded-lg border p-4"><div className="font-medium">支付宝账号</div><p className="mt-1 leading-6 text-muted">经营码是固定的，对方若保存过收款码仍可能转账；此时这笔钱不会确认任何订单、不会通知商户发货，会出现在「未匹配收款」中供你退款。账号需与账单显示一致，如 **明(138******88)。</p></div>
      </div>

      <Card>
        <CardHeader><CardTitle>添加</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-[auto_1fr_1fr_auto] md:items-end" onSubmit={submit}>
            <div className="space-y-2">
              <Label>类型</Label>
              <div className="flex w-fit rounded-md border p-1">
                {(Object.keys(kindLabels) as BlacklistKind[]).map((kind) => (
                  <Button key={kind} type="button" size="sm" variant={form.kind === kind ? "default" : "ghost"} onClick={() => setForm({ ...form, kind })}>{kindLabels[kind]}</Button>
                ))}
              </div>
            </div>
            <div className="space-y-2"><Label htmlFor="bl-value">{form.kind === "ip" ? "IP 或网段" : "支付宝账号（与账单一致）"}</Label><Input id="bl-value" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} placeholder={form.kind === "ip" ? "203.0.113.7 或 2408:8207:1234:5678::/64" : "**明(138******88)"} required /></div>
            <div className="space-y-2"><Label htmlFor="bl-note">备注（可选）</Label><Input id="bl-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} maxLength={200} placeholder="例如：恶意投诉" /></div>
            <Button disabled={saving}><Plus />{saving ? "正在添加…" : "拉黑"}</Button>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle>黑名单列表</CardTitle><CardDescription>“拦截次数”为拒绝下单、锁定收银台或拦截付款确认的累计次数。</CardDescription></CardHeader>
        <CardContent>
          {isLoading || !data ? <Loading /> : data.data.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-muted"><Ban className="size-6" />黑名单为空</div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b text-xs text-muted"><tr><th className="pb-3 font-medium">类型</th><th className="pb-3 font-medium">值</th><th className="pb-3 font-medium">备注</th><th className="pb-3 font-medium">拦截次数</th><th className="pb-3 font-medium">最近拦截</th><th className="pb-3 font-medium">添加时间</th><th className="pb-3" /></tr></thead>
                <tbody className="divide-y">
                  {data.data.map((entry) => (
                    <tr key={entry.id}>
                      <td className="py-3"><Badge variant={entry.kind === "ip" ? "outline" : "primary"}>{kindLabels[entry.kind]}</Badge></td>
                      <td className="py-3 break-all font-mono text-xs">{entry.value}</td>
                      <td className="max-w-48 py-3 text-muted">{entry.note || "—"}</td>
                      <td className="py-3 font-mono">{entry.hits}</td>
                      <td className="py-3 text-xs text-muted">{formatDate(entry.last_hit_at)}</td>
                      <td className="py-3 text-xs text-muted">{formatDate(entry.created_at)}<div>{entry.created_by}</div></td>
                      <td className="py-3 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setConfirmation({
                          title: "移出黑名单",
                          description: `移出后 ${entry.value} 可以重新下单付款。已被锁定的订单不会恢复，需要重新下单。`,
                          confirmLabel: "确认移出",
                          action: async () => {
                            try {
                              await apiFetch(`/admin-api/blacklist/${entry.id}`, { method: "DELETE" });
                              toast.success("已移出黑名单");
                              await mutate();
                            } catch (error) { toast.error(error instanceof Error ? error.message : "操作失败"); }
                          },
                        })}><Trash2 />移出</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmationDialog value={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}
