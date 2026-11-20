import { Eye, KeyRound, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { apiFetch, jsonBody } from "@/web/api";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Label } from "@/web/components/ui/label";
import { Textarea } from "@/web/components/ui/textarea";
import {
  ConfirmationDialog,
  DisclosureDialog,
  toBarePrivateKey,
  toBarePublicKey,
  type Confirmation,
  type KeyDisclosure,
} from "@/web/pages/keys";

interface MerchantKeyInfo {
  pid: string;
  v1_key_masked: string;
  v2_public_key: string;
}

/**
 * V1 MD5 key and V2 merchant public key for one merchant.
 * `base` is "/admin-api/merchants/:id" for admins or "/merchant-api" for the merchant itself.
 */
export function MerchantKeysPanel({ base, merchant, onChange }: { base: string; merchant: MerchantKeyInfo; onChange: () => unknown }) {
  const [disclosure, setDisclosure] = useState<KeyDisclosure | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [publicImport, setPublicImport] = useState("");
  const v2PublicKey = toBarePublicKey(merchant.v2_public_key);

  async function post<T>(path: string, success?: string) {
    try {
      const result = await apiFetch<T>(`${base}${path}`, { method: "POST" });
      if (success) toast.success(success);
      await onChange();
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      return null;
    }
  }

  const showV1 = (title: string, result: { pid: string; key: string }) => setDisclosure({
    title,
    privateKey: `PID=${result.pid}\nKEY=${result.key}`,
    privateKeyLabel: "PID 与 MD5 key",
    privateKeyFilename: `v1-credentials-${result.pid}.txt`,
  });

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between"><CardTitle>易支付 V1 · MD5</CardTitle><Badge variant={merchant.v1_key_masked ? "success" : "danger"}>{merchant.v1_key_masked ? "已配置" : "缺失"}</Badge></div>
          <CardDescription>使用 PID 与 32 位 key 对请求做 MD5 签名；支付通知也用这把 key 签名。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border p-3"><div className="text-xs text-muted">商户 PID</div><div className="mt-1 font-mono text-sm">{merchant.pid}</div></div>
          <div className="rounded-md border p-3"><div className="text-xs text-muted">MD5 key</div><div className="mt-1 font-mono text-sm">{merchant.v1_key_masked || "—"}</div></div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={async () => {
              const result = await post<{ pid: string; key: string }>("/keys/v1/reveal");
              if (result) showV1("V1 商户凭据", result);
            }}><Eye />查看凭据</Button>
            <Button variant="danger" onClick={() => setConfirmation({
              title: "重新生成 V1 key",
              description: "旧 key 会立即失效，使用该商户 V1 接口的程序必须更新配置。",
              confirmLabel: "确认重新生成",
              action: async () => {
                const result = await post<{ pid: string; key: string }>("/keys/v1/regenerate", "V1 key 已更新");
                if (result) showV1("新的 V1 商户凭据", result);
              },
            })}><RefreshCw />重新生成</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between"><CardTitle>易支付 V2 · 商户密钥</CardTitle><Badge variant={v2PublicKey ? "success" : "danger"}>{v2PublicKey ? "公钥已登记" : "未登记"}</Badge></div>
          <CardDescription>商户私钥签名请求；服务端只保存商户公钥，私钥不会留存。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {v2PublicKey ? <div className="space-y-2"><Label htmlFor={`${base}-v2-pub`}>当前商户公钥（单行 Base64）</Label><Textarea id={`${base}-v2-pub`} className="font-mono text-xs" value={v2PublicKey} readOnly rows={4} /></div> : null}
          <Button onClick={() => {
            const run = async () => {
              const result = await post<{ private_key: string; public_key: string }>("/keys/v2/generate", "商户密钥已生成");
              if (result) setDisclosure({
                title: "V2 商户密钥",
                privateKey: toBarePrivateKey(result.private_key),
                privateKeyLabel: "商户私钥（PKCS#8 单行 Base64）",
                privateKeyHelp: "由商户程序用于签名请求；服务端不会保存，也不会再次展示。",
                privateKeyFilename: `v2-merchant-private-key-${merchant.pid}.txt`,
                publicKey: toBarePublicKey(result.public_key),
                publicKeyLabel: "商户公钥（单行 Base64）",
                publicKeyHelp: "服务端只保存这把公钥。",
                oneTime: true,
              });
            };
            if (!v2PublicKey) return void run();
            setConfirmation({ title: "重新生成 V2 商户密钥", description: "旧商户公钥会被替换，使用旧私钥签名的请求将全部失败。", confirmLabel: "确认生成", action: run });
          }}><KeyRound />生成商户密钥对</Button>
          <div className="space-y-3 border-t pt-4">
            <Label htmlFor={`${base}-v2-import`}>导入已有商户公钥</Label>
            <Textarea id={`${base}-v2-import`} className="font-mono text-xs" value={publicImport} onChange={(event) => setPublicImport(event.target.value)} rows={4} placeholder="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..." />
            <p className="text-xs leading-5 text-muted">支持单行 Base64 或带 BEGIN/END 的完整 PEM；导入后立即用于验证请求签名。</p>
            <Button variant="outline" disabled={!publicImport.trim()} onClick={async () => {
              try {
                await apiFetch(`${base}/keys/v2`, { method: "PUT", ...jsonBody({ public_key: publicImport.trim() }) });
                toast.success("商户公钥已导入");
                setPublicImport("");
                await onChange();
              } catch (error) { toast.error(error instanceof Error ? error.message : "导入失败"); }
            }}><Upload />导入公钥</Button>
          </div>
        </CardContent>
      </Card>
      <DisclosureDialog value={disclosure} onClose={() => setDisclosure(null)} />
      <ConfirmationDialog value={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
}
