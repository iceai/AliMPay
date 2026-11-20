import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import useSWR from "swr";
import { ApiClientError, swrFetcher } from "@/web/api";
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
import { OrderDetailPage } from "@/web/pages/order-detail";
import { OrdersPage } from "@/web/pages/orders";
import { PaymentsPage } from "@/web/pages/payments";
import { SettingsPage } from "@/web/pages/settings";
import { SetupPage } from "@/web/pages/setup";
import { SystemPage } from "@/web/pages/system";

function RequireAdmin({ children }: { children: ReactNode }) {
  const { data, error, isLoading } = useSWR<{ user: { username: string } }>("/admin-api/me", swrFetcher, { shouldRetryOnError: false });
  if (isLoading) return <Loading label="正在验证会话" />;
  if (error instanceof ApiClientError && error.status === 401) return <Navigate to="/login" replace />;
  if (error || !data) return <Navigate to="/login" replace />;
  return children;
}

function Home() {
  const { data, isLoading } = useSWR<{ setup_completed: boolean }>("/admin-api/setup/status", swrFetcher);
  if (isLoading) return <Loading />;
  return <Navigate to={data?.setup_completed ? "/dashboard" : "/setup"} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/checkout/:token" element={<CheckoutPage />} />
      <Route element={<RequireAdmin><AppShell /></RequireAdmin>}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/orders/:id" element={<OrderDetailPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/merchants" element={<MerchantsPage />} />
        <Route path="/merchants/:id" element={<MerchantDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/keys" element={<KeyCenterPage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/system" element={<SystemPage />} />
      </Route>
      <Route path="/merchant/login" element={<MerchantLoginPage />} />
      <Route path="/merchant" element={<Navigate to="/merchant/dashboard" replace />} />
      <Route element={<RequireMerchant><MerchantShell /></RequireMerchant>}>
        <Route path="/merchant/dashboard" element={<MerchantDashboardPage />} />
        <Route path="/merchant/orders" element={<MerchantOrdersPage />} />
        <Route path="/merchant/orders/:id" element={<MerchantOrderDetailPage />} />
        <Route path="/merchant/api" element={<MerchantApiPage />} />
        <Route path="/merchant/account" element={<MerchantAccountPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
