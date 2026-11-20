import { Banknote, BookOpenText, LayoutDashboard, LogOut, Menu, ReceiptText, Store, UserCog } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import useSWR, { mutate } from "swr";
import type { MerchantSummary } from "@/shared/contracts";
import { apiFetch, swrFetcher } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/web/components/ui/dialog";
import { Loading } from "@/web/components/ui/loading";
import { cn } from "@/web/lib/utils";

const navigation = [
  { to: "/merchant/dashboard", label: "数据概览", icon: LayoutDashboard },
  { to: "/merchant/orders", label: "订单", icon: ReceiptText },
  { to: "/merchant/withdrawals", label: "提现", icon: Banknote },
  { to: "/merchant/api", label: "API 对接", icon: BookOpenText },
  { to: "/merchant/account", label: "账户设置", icon: UserCog },
];

export function useMerchantMe() {
  return useSWR<{ merchant: MerchantSummary }>("/merchant-api/me", swrFetcher, { shouldRetryOnError: false });
}

export function RequireMerchant({ children }: { children: ReactNode }) {
  const { data, error, isLoading } = useMerchantMe();
  if (isLoading) return <Loading label="正在验证会话" />;
  if (error || !data) return <Navigate to="/merchant/login" replace />;
  return children;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { data } = useMerchantMe();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-3 border-b px-5">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary text-background"><Store className="size-4" /></span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{data?.merchant.name ?? "商户后台"}</div>
          <div className="text-xs text-muted">PID {data?.merchant.pid}</div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 p-3" aria-label="商户后台导航">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) => cn(
              "flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted transition-colors hover:bg-foreground/5 hover:text-foreground",
              isActive && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-3">
        <Button
          variant="ghost"
          className="w-full justify-start text-muted"
          onClick={async () => {
            await apiFetch("/merchant-api/logout", { method: "POST" }).catch(() => undefined);
            await mutate((key) => typeof key === "string" && key.startsWith("/merchant-api/"), undefined, { revalidate: false });
            navigate("/merchant/login", { replace: true });
          }}
        >
          <LogOut />退出登录
        </Button>
      </div>
    </div>
  );
}

export function MerchantShell() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r lg:block">
        <SidebarContent />
      </aside>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/95 px-4 lg:hidden">
        <div className="flex items-center gap-2 text-sm font-semibold"><Store className="size-4 text-primary" />商户后台</div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="打开导航" title="打开导航"><Menu /></Button>
          </DialogTrigger>
          <DialogContent className="left-0 top-0 h-dvh w-72 max-w-none translate-x-0 translate-y-0 rounded-none border-y-0 border-l-0 p-0">
            <DialogTitle className="sr-only">商户后台导航</DialogTitle>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </header>
      <main className="lg:pl-60">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
