"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-sm border border-rule px-2 py-1 text-sm text-ink-soft hover:border-ink hover:text-ink"
    >
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}
