import { LogIn, Store } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { mutate } from "swr";
import { apiFetch, jsonBody } from "@/web/api";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";

export function MerchantLoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await apiFetch("/merchant-api/login", { method: "POST", ...jsonBody({ username: username.trim(), password }) });
      await mutate("/merchant-api/me");
      navigate("/merchant/dashboard", { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-primary text-background"><Store className="size-4" /></span>
          <div><div className="font-semibold">AliMPay</div><div className="text-xs text-muted">商户后台</div></div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>商户登录</CardTitle>
            <CardDescription>使用平台管理员为你开通的账号登录。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2"><Label htmlFor="m-login-user">用户名</Label><Input id="m-login-user" value={username} onChange={(event) => setUsername(event.target.value)} autoFocus autoComplete="username" required /></div>
              <div className="space-y-2"><Label htmlFor="m-login-password">密码</Label><Input id="m-login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></div>
              {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</div> : null}
              <Button className="w-full" disabled={submitting}>{submitting ? "正在验证…" : "登录"}<LogIn /></Button>
            </form>
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-xs text-muted"><Link className="hover:text-foreground" to="/login">平台管理员登录</Link></p>
      </div>
    </main>
  );
}
