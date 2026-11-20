import useSWR from "swr";
import type { MerchantSummary } from "@/shared/contracts";
import { swrFetcher } from "@/web/api";
import { CopyButton } from "@/web/components/copy-button";
import { MerchantKeysPanel } from "@/web/components/merchant-keys";
import { PageHeader } from "@/web/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { Textarea } from "@/web/components/ui/textarea";
import { DocsView } from "@/web/pages/docs";
import { toBarePublicKey } from "@/web/pages/keys";

interface MerchantKeysResponse extends MerchantSummary {
  platform_public_key: string;
  base_url: string;
  v1_enabled: boolean;
  v2_enabled: boolean;
}

export function MerchantApiPage() {
  const { data, isLoading, mutate } = useSWR<MerchantKeysResponse>("/merchant-api/keys", swrFetcher);
  if (isLoading || !data) return <Loading label="正在读取接口信息" />;
  const platformKey = toBarePublicKey(data.platform_public_key);
  const disabled = [!data.v1_enabled && "V1", !data.v2_enabled && "V2"].filter(Boolean).join("、");

  return (
    <>
      <PageHeader title="API 对接" description="兼容易支付 V1（MD5）与 V2（RSA）协议。这里的密钥仅属于你的商户，请妥善保管。" />
      {disabled ? <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted">平台当前关闭了 {disabled} 接口。</div> : null}

      <MerchantKeysPanel base="/merchant-api" merchant={data} onChange={mutate} />

      <h2 className="mb-3 mt-8 text-base font-semibold">接口文档</h2>
      <DocsView
        baseUrl={data.base_url}
        pid={data.pid}
        aside={<>
          <Card>
            <CardHeader><CardTitle>接入凭据</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><div className="text-xs text-muted">接口地址</div><div className="mt-1 break-all font-mono text-sm">{data.base_url}</div></div>
              <div><div className="text-xs text-muted">PID</div><div className="mt-1 font-mono text-sm">{data.pid}</div></div>
              <CopyButton value={data.pid} label="复制 PID" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>V2 平台公钥</CardTitle><CardDescription>用于验证接口响应与支付通知的签名。</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="platform-key" className="sr-only">V2 平台公钥</Label>
              <Textarea id="platform-key" className="font-mono text-xs" value={platformKey} readOnly rows={6} />
              <CopyButton value={platformKey} label="复制平台公钥" />
            </CardContent>
          </Card>
        </>}
      />
    </>
  );
}
