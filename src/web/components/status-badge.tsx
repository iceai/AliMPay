import type { OrderStatus } from "@/shared/contracts";
import { Badge } from "@/web/components/ui/badge";

const labels: Record<OrderStatus, string> = {
  pending: "等待支付",
  expired: "已过期",
  paid: "支付成功",
  late_paid: "迟到支付",
};

export function StatusBadge({ status, blocked = false }: { status: OrderStatus; blocked?: boolean }) {
  if (blocked && status !== "paid" && status !== "late_paid") return <Badge variant="danger">黑名单已拦截</Badge>;
  const variant = status === "paid" ? "success" : status === "late_paid" ? "primary" : status === "expired" ? "danger" : "outline";
  return <Badge variant={variant}>{labels[status]}</Badge>;
}
