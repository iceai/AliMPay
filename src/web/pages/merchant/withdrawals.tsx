import { ChevronLeft, ChevronRight, Send } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import type { MerchantBalance, WithdrawalAccountType, WithdrawalRecord, WithdrawalSettings } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { PageHeader } from "@/web/components/page-header";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { BalanceCards, PayeeInfo, WithdrawalStatusBadge } from "@/web/components/withdrawal-parts";
import { ConfirmationDialog, type Confirmation } from "@/web/pages/keys";
import { formatDate, formatMoney } from "@/web/lib/utils";

interface Response {
  data: WithdrawalRecord[];
  total: number;
  balance: MerchantBalance;
  settings: WithdrawalSettings;
  max_amount_cents: number;
  last_account: { account_type: WithdrawalAccountType; account_no: string; account_name: string; bank_name: string } | null;
}

/** Mirrors the server: fee rounded half-up to the cent. */
function feeFor(amountCents: number, feeRateBp: number) {
  return Math.round((amountCents * feeRateBp) / 10_000);
}

function toCents(value: string) {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value.trim())) return null;
  const [yuan, fraction = ""] = value.trim().split(".");
  return Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
}

function RequestForm({ data, onDone }: { data: Response; onDone: () => unknown }) {
  const [form, setForm] = useState({ amount: "", account_type: "alipay" as WithdrawalAccountType, account_no: "", account_name: "", bank_name: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const last = data.last_account;
  useEffect(() => {
    if (last) setForm((value) => ({ ...value, account_type: last.account_type, account_no: last.account_no, account_name: last.account_name, bank_name: last.bank_name }));
  }, [last?.account_no, last?.account_type]);

  const { settings, balance } = data;
  const amountCents = toCents(form.amount);
  const feeCents = amountCents ? feeFor(amountCents, settings.fee_rate_bp) : 0;
  const totalCents = (amountCents ?? 0) + feeCents;
  const tooMuch = amountCents !== null && totalCents > balance.available_cents;
  const tooSmall = amountCents !== null && amountCents < settings.min_cents;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/merchant-api/withdrawals", { method: "POST", ...jsonBody(form) });
      toast.success(`提现申请已提交，冻结 ${formatMoney(totalCents)}`);
      setForm((value) => ({ ...value, amount: "", note: "" }));
      await onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!settings.enabled) {
    return <Card><CardContent className="py-10 text-center text-sm text-muted">平台暂未开放提现，请联系平台客服。</CardContent></Card>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>申请提现</CardTitle>
        <CardDescription>手续费 {settings.fee_rate}%，在提现金额之外另行从余额扣除；单笔最低 {formatMoney(settings.min_cents)}。提交后冻结，平台打款后正式扣除。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="mw-amount">提现金额（到账金额，元）</Label>
            <div className="flex gap-2">
              <Input id="mw-amount" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder={`最多 ${(data.max_amount_cents / 100).toFixed(2)}`} required />
              <Button type="button" variant="outline" disabled={data.max_amount_cents <= 0} onClick={() => setForm({ ...form, amount: (data.max_amount_cents / 100).toFixed(2) })}>全部</Button>
            </div>
            <div className={`rounded-md border p-3 text-sm ${tooMuch || tooSmall ? "border-destructive/40 bg-destructive/5" : ""}`}>
              <div className="flex justify-between"><span className="text-muted">到账金额</span><span className="font-mono">{formatMoney(amountCents ?? 0)}</span></div>
              <div className="flex justify-between"><span className="text-muted">手续费（{settings.fee_rate}%）</span><span className="font-mono">{formatMoney(feeCents)}</span></div>
              <div className="mt-1 flex justify-between border-t pt-1 font-medium"><span>合计从余额扣除</span><span className="font-mono">{formatMoney(totalCents)}</span></div>
              {tooMuch ? <p className="mt-2 text-xs text-destructive">超出可用余额 {formatMoney(balance.available_cents)}</p> : null}
              {tooSmall ? <p className="mt-2 text-xs text-destructive">低于单笔最低提现金额 {formatMoney(settings.min_cents)}</p> : null}
            </div>
          </div>
          <div className="space-y-2">
            <Label>收款方式</Label>
            <div className="flex w-fit rounded-md border p-1">
              <Button type="button" size="sm" variant={form.account_type === "alipay" ? "default" : "ghost"} onClick={() => setForm({ ...form, account_type: "alipay" })}>支付宝</Button>
              <Button type="button" size="sm" variant={form.account_type === "bank" ? "default" : "ghost"} onClick={() => setForm({ ...form, account_type: "bank" })}>银行卡</Button>
            </div>
          </div>
          {form.account_type === "bank" ? <div className="space-y-2"><Label htmlFor="mw-bank">开户银行</Label><Input id="mw-bank" value={form.bank_name} onChange={(event) => setForm({ ...form, bank_name: event.target.value })} placeholder="例如：招商银行深圳分行" required /></div> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="mw-no">{form.account_type === "alipay" ? "支付宝账号" : "银行卡号"}</Label><Input id="mw-no" value={form.account_no} onChange={(event) => setForm({ ...form, account_no: event.target.value })} required maxLength={64} /></div>
            <div className="space-y-2"><Label htmlFor="mw-name">收款人姓名</Label><Input id="mw-name" value={form.account_name} onChange={(event) => setForm({ ...form, account_name: event.target.value })} required maxLength={32} /></div>
          </div>
          <div className="space-y-2"><Label htmlFor="mw-note">备注（可选）</Label><Input id="mw-note" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} maxLength={200} /></div>
          <Button className="w-full" disabled={submitting || amountCents === null || tooMuch || tooSmall}><Send />{submitting ? "正在提交…" : "提交提现申请"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function MerchantWithdrawalsPage() {
  const [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const { data, isLoading, mutate } = useSWR<Response>(`/merchant-api/withdrawals?page=${page}`, swrFetcher, { refreshInterval: 30_000 });
  if (isLoading || !data) return <Loading label="正在读取余额" />;
  const pages = Math.max(1, Math.ceil(data.total / 20));

  return (
    <>
      <PageHeader title="提现" description="可用余额 = 累计收入 − 已提现 − 冻结中。提现金额与手续费在申请时冻结，平台打款后正式扣除；被驳回或取消则退回。" />
      <BalanceCards balance={data.balance} />
      <div className="mt-6 grid gap-6 xl:grid-cols-[440px_1fr]">
        <RequestForm data={data} onDone={mutate} />
        <Card className="min-w-0">
          <CardHeader><CardTitle>提现记录</CardTitle></CardHeader>
          <CardContent>
            {data.data.length === 0 ? <div className="py-12 text-center text-sm text-muted">还没有提现记录</div> : (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[680px] text-left text-sm">
                  <thead className="border-b text-xs text-muted"><tr><th className="pb-3 font-medium">申请单号</th><th className="pb-3 font-medium">到账金额</th><th className="pb-3 font-medium">手续费</th><th className="pb-3 font-medium">收款账户</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">申请时间</th></tr></thead>
                  <tbody className="divide-y">
                    {data.data.map((withdrawal) => (
                      <tr key={withdrawal.id} className="align-top">
                        <td className="py-3 font-mono text-xs">{withdrawal.withdraw_no}</td>
                        <td className="py-3 font-mono font-semibold">{formatMoney(withdrawal.amount_cents)}</td>
                        <td className="py-3 font-mono text-muted">{formatMoney(withdrawal.fee_cents)}</td>
                        <td className="py-3"><PayeeInfo withdrawal={withdrawal} /></td>
                        <td className="py-3">
                          <WithdrawalStatusBadge status={withdrawal.status} />
                          {withdrawal.status === "rejected" && withdrawal.admin_note ? <div className="mt-1 max-w-40 text-xs text-destructive">原因：{withdrawal.admin_note}</div> : null}
                          {withdrawal.status === "paid" && withdrawal.payout_ref ? <div className="mt-1 max-w-40 break-all font-mono text-xs text-muted">流水 {withdrawal.payout_ref}</div> : null}
                          {withdrawal.status === "pending" ? <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={() => setConfirmation({
                            title: "取消提现申请",
                            description: `取消后冻结的 ${formatMoney(withdrawal.total_cents)} 将退回可用余额。`,
                            confirmLabel: "确认取消",
                            action: async () => {
                              try {
                                await apiFetch(`/merchant-api/withdrawals/${withdrawal.id}/cancel`, { method: "POST" });
                                toast.success("已取消，金额已退回可用余额");
                                await mutate();
                              } catch (error) { toast.error(error instanceof Error ? error.message : "取消失败"); }
                            },
                          })}>取消申请</Button> : null}
                        </td>
                        <td className="py-3 text-right text-xs text-muted">{formatDate(withdrawal.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm text-muted">
              <span>共 {data.total} 笔</span>
              <div className="flex items-center gap-2"><Button variant="outline" size="icon" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft /></Button><span className="min-w-16 text-center">{page} / {pages}</span><Button variant="outline" size="icon" aria-label="下一页" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}><ChevronRight /></Button></div>
            </div>
          </CardContent>
        </Card>
      </div>
      <ConfirmationDialog value={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}
