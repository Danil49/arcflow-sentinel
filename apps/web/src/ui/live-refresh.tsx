"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server page every few seconds while the transfer is still moving. */
export function LiveRefresh({ active, everyMs = 5_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return active ? (
    <p className="text-sm text-ink-soft">This page updates on its own while the transfer moves.</p>
  ) : null;
}
