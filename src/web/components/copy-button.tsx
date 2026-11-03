import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button, type ButtonProps } from "@/web/components/ui/button";

export function CopyButton({ value, label = "复制", ...props }: { value: string; label?: string } & Omit<ButtonProps, "onClick">) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Some in-app mobile browsers block the Clipboard API.
          const textarea = document.createElement("textarea");
          textarea.value = value;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : label}
    </Button>
  );
}
