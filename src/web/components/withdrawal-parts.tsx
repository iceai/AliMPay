import type { MerchantBalance, WithdrawalRecord, WithdrawalStatus } from "@/shared/contracts";
import { CopyButton } from "@/web/components/copy-button";
import { Badge } from "@/web/components/ui/badge";
import { Card, CardContent } from "@/web/components/ui/card";
import { formatMoney } from "@/web/lib/utils";

const labels: Record<WithdrawalStatus, string> = { pending: "待审核", paid: "已打款", rejected: "已驳回", cancelled: "已取消" };

export function WithdrawalStatusBadge({ status }: { status: WithdrawalStatus }) {
  const variant = status === "paid" ? "success" : status === "rejected" ? "danger" : status === "pending" ? "primary" : "outline";
  return <Badge variant={variant}>{labels[status]}</Badge>;
}

export const withdrawalStatusOptions: Array<{ value: WithdrawalStatus | ""; label: string }> = [
  { value: "", label: "全部" },
  { value: "pending", label: "待审核" },
  { value: "paid", label: "已打款" },
  { value: "rejected", label: "已驳回" },
  { value: "cancelled", label: "已取消" },
];

export function BalanceCards({ balance }: { balance: MerchantBalance }) {
  const items = [
    { label: "可用余额", value: balance.available_cents, note: "可申请提现", strong: true },
    { label: "冻结中", value: balance.frozen_cents, note: "待审核提现（含手续费）" },
    { label: "累计已提现", value: balance.withdrawn_cents, note: "已打款（含手续费）" },
    { label: "累计收入", value: balance.income_cents, note: "订单金额扣除订单手续费" },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="pt-5">
            <div className="text-sm text-muted">{item.label}</div>
            <div className={`mt-2 text-2xl font-semibold tracking-tight ${item.strong ? "text-primary" : ""}`}>{formatMoney(item.value)}</div>
            <p className="mt-1 text-xs text-muted">{item.note}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Payee details, with copy buttons for the admin doing the transfer. */
export function PayeeInfo({ withdrawal, copyable = false }: { withdrawal: WithdrawalRecord; copyable?: boolean }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="text-muted">{withdrawal.account_type === "alipay" ? "支付宝" : withdrawal.bank_name || "银行卡"}</div>
      <div className="flex items-center gap-2"><span className="break-all font-mono">{withdrawal.account_no}</span>{copyable ? <CopyButton value={withdrawal.account_no} label="复制" className="h-6 px-2 text-xs" /> : null}</div>
      <div className="flex items-center gap-2"><span>{withdrawal.account_name}</span>{copyable ? <CopyButton value={withdrawal.account_name} label="复制" className="h-6 px-2 text-xs" /> : null}</div>
    </div>
  );
}
