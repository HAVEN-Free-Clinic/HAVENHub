"use client";

import { useState } from "react";
import { Phone, Check } from "lucide-react";

export function PhoneCopyButton({ phone }: { phone: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!phone) {
    return <span className="text-sm text-muted-foreground">Phone not on file</span>;
  }

  const confirmedPhone: string = phone;

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(confirmedPhone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can fail in some contexts (e.g. non-HTTPS); fail silently,
      // the number is still visible as plain text.
    }
  }

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${
        copied
          ? "border-green-200 bg-green-50 text-success"
          : "border-border bg-surface text-foreground hover:bg-brand-faint hover:border-brand hover:text-brand-fg"
      }`}
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Phone className="h-3.5 w-3.5" aria-hidden />}
      {copied ? "Copied" : confirmedPhone}
    </button>
  );
}