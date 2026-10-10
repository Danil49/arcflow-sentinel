"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { cn } from "./format.js";

type Chain = "auto" | "base" | "arc";
const HASH = /^0x[0-9a-fA-F]{64}$/;

interface Problem {
  status: number;
  title?: string;
  detail?: string;
}

async function trace(sourceTxHash: string, sourceChain: "base" | "arc") {
  const res = await fetch("/api/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceTxHash, sourceChain }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok
    ? { id: body.traces[0].id as string }
    : { problem: { status: res.status, ...body } as Problem };
}

/**
 * The hero: paste a burn transaction, get its trace. With "Either chain" it tries Base first and
 * falls back to Arc when Base has no such CCTP burn.
 */
export function SearchForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const errorId = useId();
  const [hash, setHash] = useState("");
  const [chain, setChain] = useState<Chain>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = hash.trim();
    if (!HASH.test(value)) {
      setError("Paste a full transaction hash: 0x followed by 64 hex characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const order: ("base" | "arc")[] = chain === "auto" ? ["base", "arc"] : [chain];
      let last: Problem | undefined;
      for (const c of order) {
        const r = await trace(value, c);
        if ("id" in r) {
          router.push(`/traces/${r.id}`);
          return;
        }
        last = r.problem;
        if (r.problem.status !== 422) break; // only "not a burn on this chain" is worth retrying
      }
      setError(
        last?.status === 422
          ? chain === "auto"
            ? "Neither Base nor Arc has a CCTP transfer in that transaction."
            : `${chain === "arc" ? "Arc" : "Base"} has no CCTP transfer in that transaction.`
          : (last?.detail ??
              "Sentinel could not reach the chains right now. Try again in a minute."),
      );
    } catch {
      setError("Sentinel could not be reached. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const choices: { value: Chain; label: string }[] = [
    { value: "auto", label: "Either chain" },
    { value: "base", label: "From Base" },
    { value: "arc", label: "From Arc" },
  ];

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-3xl">
      <label htmlFor={inputId} className="block font-semibold">
        Burn transaction hash
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id={inputId}
          name="tx"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1 rounded-sm border-2 border-ink bg-sheet px-3.5 py-3 font-mono text-[0.95rem] placeholder:text-ink-soft/70 focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-sm bg-accent px-6 py-3 font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "Tracing…" : "Trace transfer"}
        </button>
      </div>
      <fieldset className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <legend className="sr-only">Source chain</legend>
        {choices.map((c) => (
          <label key={c.value} className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="chain"
              value={c.value}
              checked={chain === c.value}
              onChange={() => setChain(c.value)}
              className="size-4 accent-[var(--accent)]"
            />
            <span className={cn(chain === c.value ? "text-ink" : "text-ink-soft")}>{c.label}</span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p id={errorId} role="alert" className="mt-3 text-fail">
          {error}
        </p>
      )}
    </form>
  );
}
