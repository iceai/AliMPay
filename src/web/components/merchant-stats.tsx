import type { MerchantStats, PeriodStats } from "@/shared/contracts";
import { Card, CardContent } from "@/web/components/ui/card";
import { formatMoney } from "@/web/lib/utils";

const periods: Array<{ key: keyof MerchantStats; label: string }> = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "last_7_days", label: "近 7 天" },
  { key: "total", label: "累计" },
];

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className={strong ? "font-mono font-semibold" : "font-mono"}>{value}</span>
    </div>
  );
}

function PeriodCard({ label, stats }: { label: string; stats: PeriodStats }) {
  return (
    <Card>
      <CardContent className="space-y-2 pt-5">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted">{stats.paid_count} / {stats.order_count} 笔已支付</span>
        </div>
        <div className="pb-1 text-2xl font-semibold tracking-tight">{formatMoney(stats.paid_cents)}</div>
        <Row label="手续费" value={`-${formatMoney(stats.fee_cents)}`} />
        <Row label="商户应得" value={formatMoney(stats.net_cents)} strong />
      </CardContent>
    </Card>
  );
}

/** Paid volume, fees and net income per period. Amounts use the merchant's requested amount. */
export function MerchantStatsGrid({ stats }: { stats: MerchantStats }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {periods.map((period) => <PeriodCard key={period.key} label={period.label} stats={stats[period.key]} />)}
    </div>
  );
}
