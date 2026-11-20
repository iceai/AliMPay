import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import useSWR from "swr";
import { swrFetcher } from "@/web/api";
import { SessionGuard } from "@/web/components/session-guard";
import { AppShell } from "@/web/components/app-shell";
import { Loading } from "@/web/components/ui/loading";
import { CheckoutPage } from "@/web/pages/checkout";
import { DashboardPage } from "@/web/pages/dashboard";
import { DocsPage } from "@/web/pages/docs";
import { KeyCenterPage } from "@/web/pages/keys";
import { LoginPage } from "@/web/pages/login";
import { MerchantShell, RequireMerchant } from "@/web/components/merchant-shell";
import { MerchantAccountPage } from "@/web/pages/merchant/account";
import { MerchantApiPage } from "@/web/pages/merchant/api";
import { MerchantLoginPage } from "@/web/pages/merchant/login";
import { MerchantDashboardPage, MerchantOrderDetailPage, MerchantOrdersPage } from "@/web/pages/merchant/orders";
import { MerchantDetailPage } from "@/web/pages/merchant-detail";
import { MerchantsPage } from "@/web/pages/merchants";
import { MerchantWithdrawalsPage } from "@/web/pages/merchant/withdrawals";
import { WithdrawalsPage } from "@/web/pages/withdrawals";
import { BlacklistPage } from "@/web/pages/blacklist";
import { OrderDetailPage } from "@/web/pages/order-detail";
import { OrdersPage } from "@/web/pages/orders";
import { PaymentsPage } from "@/web/pages/payments";
import { SettingsPage } from "@/web/pages/settings";
import { SetupPage } from "@/web/pages/setup";
import { SystemPage } from "@/web/pages/system";

function RequireAdmin({ children }: { children: ReactNode }) {
  return <SessionGuard meKey="/admin-api/me" loginPath="/admin/login" title="AliMPay 管理后台">{children}</SessionGuard>;
}

/** Admin pages used to live at the root; these paths are still honoured for existing admin sessions. */
const LEGACY_ADMIN_PATHS = ["/dashboard", "/orders", "/payments", "/merchants", "/withdrawals", "/settings", "/keys", "/docs", "/system"];

/**
 * Where a visitor goes when the URL is not explicitly /admin/... or /merchant/... (the site root,
 * old admin links, typos). Only someone already holding an admin session is sent to the admin panel;
 * everyone else lands on the merchant side, so merchants never see the admin login.
 */
function EntryRedirect() {
  const location = useLocation();
  const setup = useSWR<{ setup_completed: boolean }>("/admin-api/setup/status", swrFetcher);
  const admin = useSWR("/admin-api/me", swrFetcher, { shouldRetryOnError: false });
  if (setup.isLoading || admin.isLoading) return <Loading />;
  if (setup.data && !setup.data.setup_completed) return <Navigate to="/admin/setup" replace />;
  if (admin.data) {
    const legacy = LEGACY_ADMIN_PATHS.some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));
    return <Navigate to={legacy ? `/admin${location.pathname}${location.search}` : "/admin/dashboard"} replace />;
  }
  return <Navigate to="/merchant/dashboard" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/checkout/:token" element={<CheckoutPage />} />

      {/* Platform admin: everything under /admin */}
      <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/admin/setup" element={<SetupPage />} />
      <Route path="/admin/login" element={<LoginPage />} />
      <Route path="/setup" element={<Navigate to="/admin/setup" replace />} />
      <Route element={<RequireAdmin><AppShell /></RequireAdmin>}>
        <Route path="/admin/dashboard" element={<DashboardPage />} />
        <Route path="/admin/orders" element={<OrdersPage />} />
        <Route path="/admin/orders/:id" element={<OrderDetailPage />} />
        <Route path="/admin/payments" element={<PaymentsPage />} />
        <Route path="/admin/merchants" element={<MerchantsPage />} />
        <Route path="/admin/merchants/:id" element={<MerchantDetailPage />} />
        <Route path="/admin/withdrawals" element={<WithdrawalsPage />} />
        <Route path="/admin/blacklist" element={<BlacklistPage />} />
        <Route path="/admin/settings" element={<SettingsPage />} />
        <Route path="/admin/keys" element={<KeyCenterPage />} />
        <Route path="/admin/docs" element={<DocsPage />} />
        <Route path="/admin/system" element={<SystemPage />} />
      </Route>

      {/* Merchant portal: everything under /merchant */}
      <Route path="/merchant/login" element={<MerchantLoginPage />} />
      <Route path="/merchant" element={<Navigate to="/merchant/dashboard" replace />} />
      <Route element={<RequireMerchant><MerchantShell /></RequireMerchant>}>
        <Route path="/merchant/dashboard" element={<MerchantDashboardPage />} />
        <Route path="/merchant/orders" element={<MerchantOrdersPage />} />
        <Route path="/merchant/orders/:id" element={<MerchantOrderDetailPage />} />
        <Route path="/merchant/withdrawals" element={<MerchantWithdrawalsPage />} />
        <Route path="/merchant/api" element={<MerchantApiPage />} />
        <Route path="/merchant/account" element={<MerchantAccountPage />} />
      </Route>
      {/* Site root, old admin links and unknown paths */}
      <Route path="*" element={<EntryRedirect />} />
    </Routes>
  );
}
