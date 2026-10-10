import { cn, humanize } from "./format.js";

/** Checks named for what they protect, in the order a reader cares about. */
const CHECKS: Record<string, { name: string; protects: string }> = {
  "value-conservation": {
    name: "Amount preserved",
    protects: "Burned amount equals minted amount plus any stated fee",
  },
  "recipient-integrity": {
    name: "Recipient unchanged",
    protects: "Funds went to the address named in the burn",
  },
  "unique-completion": { name: "Delivered once", protects: "One burn produced exactly one mint" },
  "domain-integrity": {
    name: "Correct route",
    protects: "Every step happened on the expected chains",
  },
  "progress-bound": { name: "On schedule", protects: "No step took longer than its limit" },
};
const ORDER = Object.keys(CHECKS);

const look = {
  PASS: { glyph: "✓", tone: "text-ok", word: "Passed" },
  FAIL: { glyph: "✕", tone: "text-fail", word: "Failed" },
  UNKNOWN: { glyph: "…", tone: "text-ink-soft", word: "Not decided yet" },
} as const;

export function Checks({
  invariants,
}: {
  invariants: { ruleId: string; result: string; explanation: string }[];
}) {
  if (invariants.length === 0) {
    return <p className="text-ink-soft">Checks run once the worker has looked at this transfer.</p>;
  }
  const sorted = [...invariants].sort((a, b) => ORDER.indexOf(a.ruleId) - ORDER.indexOf(b.ruleId));
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {sorted.map((inv) => {
        const meta = CHECKS[inv.ruleId] ?? { name: inv.ruleId, protects: "" };
        const l = look[inv.result as keyof typeof look] ?? look.UNKNOWN;
        return (
          <li key={inv.ruleId} className="grid grid-cols-[1.75rem_1fr] gap-x-3 py-3.5">
            <span aria-hidden className={cn("text-lg font-bold leading-6", l.tone)}>
              {l.glyph}
            </span>
            <div className="min-w-0">
              <p className="font-semibold">
                {meta.name}
                <span className={cn("ml-2 text-sm font-medium", l.tone)}>{l.word}</span>
              </p>
              <p className="mt-0.5 text-sm text-ink-soft">{meta.protects}</p>
              <p
                className={cn(
                  "mt-1.5 text-sm break-words",
                  inv.result === "FAIL" ? "text-fail" : "text-ink",
                )}
              >
                {humanize(inv.explanation)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
