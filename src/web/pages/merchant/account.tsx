import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { apiFetch, jsonBody } from "@/web/api";
import { useMerchantMe } from "@/web/components/merchant-shell";
import { PageHeader } from "@/web/components/page-header";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { formatDate } from "@/web/lib/utils";

export function MerchantAccountPage() {
  const { data } = useMerchantMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const merchant = data?.merchant;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) return void toast.error("两次输入的新密码不一致");
    setSaving(true);
    try {
      await apiFetch("/merchant-api/password", { method: "PUT", ...jsonBody({ current_password: current, new_password: next }) });
      toast.success("密码已修改，其他设备上的登录已失效");
      setCurrent(""); setNext(""); setConfirm("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="账户设置" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>商户信息</CardTitle><CardDescription>名称和费率由平台管理员设置。</CardDescription></CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 text-sm">
              <div><dt className="text-xs text-muted">商户名称</dt><dd className="mt-1">{merchant?.name}</dd></div>
              <div><dt className="text-xs text-muted">PID</dt><dd className="mt-1 font-mono">{merchant?.pid}</dd></div>
              <div><dt className="text-xs text-muted">登录用户名</dt><dd className="mt-1 font-mono">{merchant?.username}</dd></div>
              <div><dt className="text-xs text-muted">手续费率</dt><dd className="mt-1 font-mono">{merchant?.fee_rate}%</dd></div>
              <div><dt className="text-xs text-muted">开通时间</dt><dd className="mt-1">{formatDate(merchant?.created_at ?? null)}</dd></div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>修改密码</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2"><Label htmlFor="ma-current">当前密码</Label><Input id="ma-current" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required /></div>
              <div className="space-y-2"><Label htmlFor="ma-next">新密码</Label><Input id="ma-next" type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={8} required /></div>
              <div className="space-y-2"><Label htmlFor="ma-confirm">确认新密码</Label><Input id="ma-confirm" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" minLength={8} required /></div>
              <Button disabled={saving}>{saving ? "正在保存…" : "修改密码"}</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
