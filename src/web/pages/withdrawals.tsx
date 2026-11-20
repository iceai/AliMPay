import { Banknote, Check, ChevronLeft, ChevronRight, Save, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import useSWR, { mutate as globalMutate } from "swr";
import { toast } from "sonner";
import type { WithdrawalRecord, WithdrawalSettings, WithdrawalStatus } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/web/components/ui/dialog";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { Switch } from "@/web/components/ui/switch";
import { PayeeInfo, WithdrawalStatusBadge, withdrawalStatusOptions } from "@/web/components/withdrawal-parts";
import { formatDate, formatMoney } from "@/web/lib/utils";

interface WithdrawalsResponse {
  data: WithdrawalRecord[];
  total: number;
  page: number;
  pending: { count: number; amount_cents: number };
  settings: WithdrawalSettings;
}

function SettingsCard({ settings, onSaved }: { settings: WithdrawalSettings; onSaved: () => unknown }) {
  const [form, setForm] = useState({ enabled: true, fee_rate: "8", min_amount: "1.00" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setForm({ enabled: settings.enabled, fee_rate: settings.fee_rate, min_amount: (settings.min_cents / 100).toFixed(2) });
  }, [settings]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/admin-api/withdrawal-settings", { method: "PUT", ...jsonBody(form) });
      toast.success("提现设置已保存");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>提现设置</CardTitle><CardDescription>手续费在提现金额之外另行扣除：提现 100 元、费率 8% 时，商户到账 100 元，余额扣除 108 元。</CardDescription></CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end" onSubmit={submit}>
          <div className="space-y-2"><Label htmlFor="wd-fee">提现手续费（%）</Label><Input id="wd-fee" inputMode="decimal" value={form.fee_rate} onChange={(event) => setForm({ ...form, fee_rate: event.target.value })} required /></div>
          <div className="space-y-2"><Label htmlFor="wd-min">单笔最低提现（元）</Label><Input id="wd-min" inputMode="decimal" value={form.min_amount} onChange={(event) => setForm({ ...form, min_amount: event.target.value })} required /></div>
          <label className="flex h-9 items-center gap-2 text-sm"><Switch checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked })} aria-label="开放提现" />开放提现</label>
          <Button disabled={saving}><Save />{saving ? "正在保存…" : "保存"}</Button>
        </form>
        <p className="mt-3 text-xs text-muted">修改费率只影响之后提交的申请，已提交的申请按提交时的费率计算。</p>
      </CardContent>
    </Card>
  );
}

type Action = { kind: "pay" | "reject"; withdrawal: WithdrawalRecord };

function ActionDialog({ action, onClose, onDone }: { action: Action | null; onClose: () => void; onDone: () => unknown }) {
  const [payoutRef, setPayoutRef] = useState("");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => { setPayoutRef(""); setNote(""); }, [action]);
  const withdrawal = action?.withdrawal;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || !withdrawal) return;
    setWorking(true);
    try {
      if (action.kind === "pay") {
        await apiFetch(`/admin-api/withdrawals/${withdrawal.id}/pay`, { method: "POST", ...jsonBody({ payout_ref: payoutRef, admin_note: note }) });
        toast.success(`已确认打款，商户余额扣除 ${formatMoney(withdrawal.total_cents)}`);
      } else {
        await apiFetch(`/admin-api/withdrawals/${withdrawal.id}/reject`, { method: "POST", ...jsonBody({ reason: note }) });
        toast.success("已驳回，冻结金额已退回商户可用余额");
      }
      onClose();
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => { if (!open && !working) onClose(); }}>
      <DialogContent>
        <DialogTitle>{action?.kind === "pay" ? "确认已打款" : "驳回提现申请"}</DialogTitle>
        <DialogDescription>
          {action?.kind === "pay"
            ? "请先通过支付宝或银行完成转账，再点击确认。确认后将从商户余额永久扣除提现金额和手续费，不可撤销。"
            : "驳回后冻结的金额和手续费会退回商户可用余额。"}
        </DialogDescription>
        {withdrawal ? (
          <form className="mt-4 space-y-4" onSubmit={submit}>
            <div className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm">
              <div><div className="text-xs text-muted">商户</div><div>{withdrawal.merchant_name}</div></div>
              <div><div className="text-xs text-muted">申请单号</div><div className="font-mono text-xs">{withdrawal.withdraw_no}</div></div>
              <div><div className="text-xs text-muted">应打款金额</div><div className="text-lg font-semibold text-primary">{formatMoney(withdrawal.amount_cents)}</div></div>
              <div><div className="text-xs text-muted">手续费 / 合计扣除</div><div>{formatMoney(withdrawal.fee_cents)} / {formatMoney(withdrawal.total_cents)}</div></div>
              <div className="col-span-2"><div className="mb-1 text-xs text-muted">收款账户</div><PayeeInfo withdrawal={withdrawal} copyable /></div>
            </div>
            {action?.kind === "pay" ? (
              <>
                <div className="space-y-2"><Label htmlFor="wd-ref">转账流水号（可选）</Label><Input id="wd-ref" value={payoutRef} onChange={(event) => setPayoutRef(event.target.value)} maxLength={128} placeholder="支付宝订单号或银行流水号，商户可见" /></div>
                <div className="space-y-2"><Label htmlFor="wd-note">备注（可选）</Label><Input id="wd-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} /></div>
              </>
            ) : (
              <div className="space-y-2"><Label htmlFor="wd-reason">驳回原因</Label><Input id="wd-reason" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} required placeholder="商户可见，例如：收款账号与姓名不符" /></div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={working} onClick={onClose}>取消</Button>
              <Button variant={action?.kind === "pay" ? "default" : "danger"} disabled={working}>{working ? "正在处理…" : action?.kind === "pay" ? "确认已打款" : "确认驳回"}</Button>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function WithdrawalsPage() {
  const [status, setStatus] = useState<WithdrawalStatus | "">("pending");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<Action | null>(null);
  const { data, isLoading, mutate } = useSWR<WithdrawalsResponse>(`/admin-api/withdrawals?status=${status}&page=${page}`, swrFetcher, { refreshInterval: 15_000 });
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20));
  const refresh = async () => { await mutate(); await globalMutate("/admin-api/dashboard"); };

  return (
    <>
      <PageHeader title="提现管理" description="审核商户提现申请。申请提交时冻结提现金额与手续费；确认打款后从商户余额扣除，驳回则退回。" />
      {data ? (
        <div className="mb-6 flex items-center gap-3 rounded-lg border p-4">
          <Banknote className="size-5 text-primary" />
          <div className="text-sm">待审核 <span className="font-semibold">{data.pending.count}</span> 笔，待打款合计 <span className="font-semibold">{formatMoney(data.pending.amount_cents)}</span></div>
        </div>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <div className="mb-5 flex flex-wrap gap-1 rounded-md border p-1 sm:w-fit" role="tablist" aria-label="提现状态">
            {withdrawalStatusOptions.map((option) => (
              <Button key={option.value} type="button" size="sm" variant={status === option.value ? "default" : "ghost"} onClick={() => { setStatus(option.value); setPage(1); }}>{option.label}</Button>
            ))}
          </div>
          {isLoading || !data ? <Loading /> : data.data.length === 0 ? <div className="py-16 text-center text-sm text-muted">没有提现申请</div> : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="border-b text-xs text-muted">
                  <tr><th className="pb-3 font-medium">商户</th><th className="pb-3 font-medium">申请单号</th><th className="pb-3 font-medium">打款金额</th><th className="pb-3 font-medium">手续费</th><th className="pb-3 font-medium">合计扣除</th><th className="pb-3 font-medium">收款账户</th><th className="pb-3 font-medium">状态</th><th className="pb-3 font-medium">申请时间</th><th className="pb-3 text-right font-medium">操作</th></tr>
                </thead>
                <tbody className="divide-y">
                  {data.data.map((withdrawal) => (
                    <tr key={withdrawal.id} className="align-top">
                      <td className="py-3"><Link className="hover:text-primary" to={`/admin/merchants/${withdrawal.merchant_id}`}>{withdrawal.merchant_name}</Link><div className="font-mono text-xs text-muted">{withdrawal.merchant_pid}</div></td>
                      <td className="py-3 font-mono text-xs">{withdrawal.withdraw_no}{withdrawal.merchant_note ? <div className="mt-1 max-w-40 font-sans text-muted">备注：{withdrawal.merchant_note}</div> : null}</td>
                      <td className="py-3 font-mono font-semibold">{formatMoney(withdrawal.amount_cents)}</td>
                      <td className="py-3 font-mono text-muted">{formatMoney(withdrawal.fee_cents)}<div className="text-xs">{withdrawal.fee_rate_bp / 100}%</div></td>
                      <td className="py-3 font-mono">{formatMoney(withdrawal.total_cents)}</td>
                      <td className="py-3"><PayeeInfo withdrawal={withdrawal} copyable={withdrawal.status === "pending"} /></td>
                      <td className="py-3"><WithdrawalStatusBadge status={withdrawal.status} />{withdrawal.payout_ref ? <div className="mt-1 max-w-36 break-all font-mono text-xs text-muted">{withdrawal.payout_ref}</div> : null}{withdrawal.admin_note ? <div className="mt-1 max-w-36 text-xs text-muted">{withdrawal.admin_note}</div> : null}</td>
                      <td className="py-3 text-xs text-muted">{formatDate(withdrawal.created_at)}{withdrawal.reviewed_at ? <div>处理 {formatDate(withdrawal.reviewed_at)}</div> : null}</td>
                      <td className="py-3 text-right">
                        {withdrawal.status === "pending" ? (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => setAction({ kind: "pay", withdrawal })}><Check />确认打款</Button>
                            <Button size="sm" variant="outline" onClick={() => setAction({ kind: "reject", withdrawal })}><X />驳回</Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm text-muted">
            <span>共 {data?.total ?? 0} 笔</span>
            <div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft /></Button><span className="min-w-16 text-center">{page} / {pages}</span><Button variant="outline" size="icon" aria-label="下一页" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight /></Button></div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6">{data ? <SettingsCard settings={data.settings} onSaved={mutate} /> : null}</div>
      <ActionDialog action={action} onClose={() => setAction(null)} onDone={refresh} />
    </>
  );
}
