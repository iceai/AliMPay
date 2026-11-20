import { RefreshCw, WifiOff } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Navigate } from "react-router-dom";
import useSWR, { mutate } from "swr";
import { ApiClientError, apiFetch, swrFetcher } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { Loading } from "@/web/components/ui/loading";

/** Only these mean "not logged in". Network errors, 5xx (e.g. during a restart) or 429 must not log the user out. */
function isLoggedOut(error: unknown) {
  return error instanceof ApiClientError && (error.status === 401 || error.code === "MERCHANT_DISABLED");
}

/**
 * Gate for an authenticated area. `meKey` is the area's own "who am I" endpoint, so the admin and
 * merchant areas never share session state.
 */
export function SessionGuard({ meKey, loginPath, title, children }: { meKey: string; loginPath: string; title: string; children: ReactNode }) {
  const { data, error, isLoading, isValidating, mutate: retry } = useSWR(meKey, swrFetcher, {
    shouldRetryOnError: (caught: unknown) => !isLoggedOut(caught),
    errorRetryInterval: 3_000,
  });
  useEffect(() => { document.title = title; }, [title]);

  if (isLoading) return <Loading label="正在验证会话" />;
  if (data) return children;
  if (isLoggedOut(error)) return isValidating ? <Loading label="正在验证会话" /> : <Navigate to={loginPath} replace />;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <WifiOff className="mx-auto size-9 text-muted" />
        <h1 className="mt-4 text-lg font-semibold">暂时无法连接服务器</h1>
        <p className="mt-2 text-sm text-muted">登录状态仍然有效，网络恢复或服务重启完成后会自动重连。</p>
        <Button className="mt-5" variant="outline" disabled={isValidating} onClick={() => void retry()}><RefreshCw />{isValidating ? "正在重试…" : "立即重试"}</Button>
      </div>
    </main>
  );
}

/**
 * After a successful login, replace the cached "who am I" result (possibly a stale 401) with the
 * fresh identity before navigating, so the guard never sees the old error.
 */
export async function primeSession(meKey: string) {
  const me = await apiFetch(meKey);
  await mutate(meKey, me, { revalidate: false });
}
