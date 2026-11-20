import { AlertTriangle, Download, KeyRound, RefreshCw, Upload } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import type { PublicSettings } from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { CopyButton } from "@/web/components/copy-button";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/web/components/ui/dialog";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { Textarea } from "@/web/components/ui/textarea";

interface KeySettings extends PublicSettings {
  alipay_app_public_key: string;
  has_alipay_private_key: boolean;
  has_v2_platform_private_key: boolean;
}

export interface KeyDisclosure {
  title: string;
  privateKey?: string;
  privateKeyLabel?: string;
  privateKeyHelp?: string;
  privateKeyFilename?: string;
  publicKey?: string;
  publicKeyLabel?: string;
  publicKeyHelp?: string;
  oneTime?: boolean;
}

export interface Confirmation {
  title: string;
  description: string;
  confirmLabel?: string;
  action: () => Promise<void>;
}

export function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function toBarePublicKey(value: string) {
  return value
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
}

export function toBarePrivateKey(value: string) {
  return value
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
}

export function DisclosureDialog({ value, onClose }: { value: KeyDisclosure | null; onClose: () => void }) {
  const privateKeyId = useId();
  const publicKeyId = useId();
  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{value?.title}</DialogTitle>
        <DialogDescription>{value?.oneTime ? "私钥只在本次响应中展示，关闭前请复制并安全保存。" : "请将密钥存放在受控的密码管理器中。"}</DialogDescription>
        {value?.privateKey ? <div className="space-y-2 pt-2"><Label htmlFor={privateKeyId}>{value.privateKeyLabel ?? "私钥（PKCS#8 单行 Base64）"}</Label><Textarea id={privateKeyId} className="font-mono text-xs" value={value.privateKey} readOnly rows={8} /><div className="flex gap-2"><CopyButton value={value.privateKey} label="复制私钥" /><Button variant="outline" size="sm" onClick={() => download(value.privateKeyFilename ?? "private-key.txt", value.privateKey!)}><Download />下载 TXT</Button></div>{value.privateKeyHelp ? <p className="text-xs leading-5 text-muted">{value.privateKeyHelp}</p> : null}</div> : null}
        {value?.publicKey ? <div className="space-y-2 pt-2"><Label htmlFor={publicKeyId}>{value.publicKeyLabel ?? "公钥（SPKI 单行 Base64）"}</Label><Textarea id={publicKeyId} className="font-mono text-xs" value={value.publicKey} readOnly rows={6} /><CopyButton value={value.publicKey} label="复制公钥" />{value.publicKeyHelp ? <p className="text-xs leading-5 text-muted">{value.publicKeyHelp}</p> : null}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmationDialog({ value, onClose }: { value: Confirmation | null; onClose: () => void }) {
  const [working, setWorking] = useState(false);
  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open && !working) onClose(); }}>
      <DialogContent>
        <DialogTitle>{value?.title}</DialogTitle>
        <DialogDescription>{value?.description}</DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={working} onClick={onClose}>取消</Button>
          <Button variant="danger" disabled={working} onClick={async () => {
            if (!value) return;
            setWorking(true);
            try { await value.action(); onClose(); } finally { setWorking(false); }
          }}>{working ? "正在处理…" : value?.confirmLabel ?? "确认轮换"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function KeyCenterPage() {
  const { data, isLoading, mutate } = useSWR<KeySettings>("/admin-api/settings", swrFetcher);
  const [disclosure, setDisclosure] = useState<KeyDisclosure | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [alipayPrivateImport, setAlipayPrivateImport] = useState("");
  if (isLoading || !data) return <Loading label="正在读取密钥状态" />;
  const v2PlatformPublicKey = toBarePublicKey(data.v2_platform_public_key);
  const alipayUploadPublicKey = toBarePublicKey(data.alipay_app_public_key);

  async function call<T>(path: string, title: string) {
    try {
      const result = await apiFetch<T>(path, { method: "POST" });
      toast.success(title);
      await mutate();
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      return null;
    }
  }

  return (
    <>
      <PageHeader title="密钥中心" description="平台级凭据：支付宝应用密钥与 V2 平台密钥。各商户的 V1 MD5 key 与 V2 商户公钥在“商户管理”中按商户单独配置。" />
      <div className="mb-6 flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm leading-6 text-muted"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" /><div><span className="font-semibold text-foreground">不要复用密钥。</span> 支付宝应用密钥、V2 平台密钥与各商户的接口密钥各自承担不同的信任方向。V2 平台密钥由所有商户共用验签，轮换后所有 V2 商户都需同步新平台公钥。<Link className="ml-1 text-primary hover:underline" to="/admin/merchants">前往商户管理 →</Link></div></div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader><div className="flex items-center justify-between"><CardTitle>易支付 V2 · 平台密钥</CardTitle><Badge variant={data.has_v2_platform_private_key ? "success" : "danger"}>{data.has_v2_platform_private_key ? "已配置" : "缺失"}</Badge></div><CardDescription>平台私钥签名接口响应与支付通知，商户使用平台公钥验签。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="v2-platform-public-key">平台公钥（单行 Base64）</Label>
              <Textarea id="v2-platform-public-key" className="font-mono text-xs" value={v2PlatformPublicKey} readOnly rows={5} />
              <p className="text-xs leading-5 text-muted">提供给商户程序验签，可直接用于只接受 <code className="font-mono">MIIB...</code> 格式的客户端。</p>
            </div>
            <div className="flex flex-wrap gap-2"><CopyButton value={v2PlatformPublicKey} label="复制平台公钥" /><Button variant="danger" onClick={() => setConfirmation({
              title: "轮换 V2 平台密钥",
              description: "旧平台公钥会立即失效，所有 V2 商户都必须同步新公钥。",
              action: async () => {
                const result = await call<{ private_key: string; public_key: string }>("/admin-api/keys/v2/platform/regenerate", "V2 平台密钥已轮换");
                if (result) setDisclosure({
                  title: "新的 V2 平台密钥",
                  privateKey: toBarePrivateKey(result.private_key),
                  privateKeyLabel: "平台私钥（PKCS#8 单行 Base64）",
                  privateKeyHelp: "服务端已加密保存；请勿提供给商户或第三方。",
                  privateKeyFilename: "v2-platform-private-key.txt",
                  publicKey: toBarePublicKey(result.public_key),
                  publicKeyLabel: "平台公钥（单行 Base64）",
                  publicKeyHelp: "提供给商户程序验签；旧平台公钥已经失效。",
                });
              },
            })}><RefreshCw />轮换密钥</Button></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div className="flex items-center justify-between"><CardTitle>支付宝应用密钥</CardTitle><Badge variant={data.has_alipay_private_key ? "success" : "danger"}>{data.has_alipay_private_key ? "应用私钥已保存" : "未配置"}</Badge></div><CardDescription>应用私钥签名支付宝 V3 请求；应用公钥需上传到支付宝开放平台。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {alipayUploadPublicKey ? <><div className="text-xs font-medium">应用公钥（支付宝上传格式）</div><Textarea value={alipayUploadPublicKey} readOnly rows={5} /><CopyButton value={alipayUploadPublicKey} label="复制应用公钥" /><p className="text-xs leading-5 text-muted">已自动去掉 PEM 头尾和换行，请把复制的整行内容填写到支付宝开放平台的应用公钥配置中。</p></> : null}
            <Button onClick={async () => {
              const result = await call<{ private_key: string; public_key: string }>("/admin-api/keys/alipay/generate", "支付宝应用密钥已生成");
              if (result) setDisclosure({
                title: "支付宝应用密钥",
                privateKey: toBarePrivateKey(result.private_key),
                privateKeyLabel: "应用私钥（PKCS#8 单行 Base64）",
                privateKeyHelp: "程序已加密保存；请作为应用密钥备份，不要上传到支付宝开放平台。",
                privateKeyFilename: "alipay-app-private-key.txt",
                publicKey: toBarePublicKey(result.public_key),
                publicKeyLabel: "应用公钥（支付宝上传格式）",
                publicKeyHelp: "已自动去掉 PEM 头尾和换行，可直接填写到支付宝开放平台的应用公钥配置中。",
              });
            }}><KeyRound />生成应用密钥</Button>
            <div className="space-y-3 border-t pt-4"><Label htmlFor="alipay-private-import">导入已有应用私钥</Label><Textarea id="alipay-private-import" className="font-mono text-xs" aria-describedby="alipay-private-import-help" value={alipayPrivateImport} onChange={(event) => setAlipayPrivateImport(event.target.value)} rows={6} placeholder="MIIEvQIBADANBgkqhkiG9w0BAQEFAASC..." /><p id="alipay-private-import-help" className="text-xs leading-5 text-muted">支持 PKCS#8 单行 Base64 或带 BEGIN/END 的完整 PEM。</p><Button variant="outline" disabled={!alipayPrivateImport.trim()} onClick={async () => {
              try { await apiFetch("/admin-api/keys/alipay/private", { method: "PUT", ...jsonBody({ private_key: alipayPrivateImport.trim() }) }); toast.success("应用私钥已导入"); setAlipayPrivateImport(""); await mutate(); }
              catch (error) { toast.error(error instanceof Error ? error.message : "导入失败"); }
            }}><Upload />导入私钥</Button></div>
          </CardContent>
        </Card>
      </div>
      <DisclosureDialog value={disclosure} onClose={() => setDisclosure(null)} />
      <ConfirmationDialog value={confirmation} onClose={() => setConfirmation(null)} />
    </>
  );
}
