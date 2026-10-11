import Link from "next/link";
import { getContext } from "@/context";
import { loadRecent } from "@/views";
import { chainName, formatAgo, formatUsdc } from "@/ui/format";
import { SearchForm } from "@/ui/search-form";
import { StatusText } from "@/ui/status";

export const dynamic = "force-dynamic";

async function recent() {
  try {
    return await loadRecent(getContext());
  } catch {
    return null; // the search still works when the list cannot load
  }
}

export default async function Home() {
  const traces = await recent();
  const now = new Date();
  return (
    <>
      <section className="pt-20 pb-16 sm:pt-28">
        <h1 className="max-w-[14ch] text-[clamp(2.75rem,7vw,5.25rem)] font-extrabold leading-[0.95] tracking-[-0.03em]">
          Where is this transfer?
        </h1>
        <p className="mt-6 max-w-[58ch] text-lg leading-relaxed text-ink-soft">
          Paste the transaction that burned USDC on Base or Arc. Sentinel follows it through
          Circle&apos;s attestation to the mint on the other side, checks that nothing changed on
          the way, and signs what it saw.
        </p>
        <div className="mt-10">
          <SearchForm autoFocus />
        </div>
      </section>

      <section aria-labelledby="recent" className="border-t-2 border-ink pt-6">
        <h2 id="recent" className="text-xl font-bold">
          Recently traced
        </h2>
        {traces === null ? (
          <p className="mt-4 text-ink-soft">
            The list of traced transfers is unavailable right now.
          </p>
        ) : traces.length === 0 ? (
          <p className="mt-4 text-ink-soft">
            Nothing traced yet. Paste a burn transaction above to start.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-rule">
            {traces.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/traces/${t.id}`}
                  className="grid grid-cols-2 items-baseline gap-x-4 gap-y-1 py-3.5 hover:bg-sheet sm:grid-cols-[9rem_15rem_1fr_7rem] sm:px-2"
                >
                  <span className="font-medium">
                    {chainName(t.route.sourceChain)} to {chainName(t.route.destinationChain)}
                    {t.isDemo && (
                      <span className="ml-2 text-sm font-normal text-ink-soft">demo</span>
                    )}
                  </span>
                  <span className="whitespace-nowrap text-right font-mono sm:text-left">
                    {formatUsdc(t.amountAtomic)} USDC
                  </span>
                  <StatusText progress={t.progress} reason={t.reason} />
                  <span className="text-right text-sm text-ink-soft">
                    {formatAgo(t.firstSeenAt, now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
