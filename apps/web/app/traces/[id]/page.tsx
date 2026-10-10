import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getContext } from "@/context";
import { loadTraceView, type TraceView } from "@/views";
import { Checks } from "@/ui/checks";
import { CopyButton } from "@/ui/copy-button";
import { chainName, cn, formatUsdc, formatUtc, humanize, shortHash } from "@/ui/format";
import { LiveRefresh } from "@/ui/live-refresh";
import { RouteRail } from "@/ui/route-rail";
import { headline, isLive, stationsFor } from "@/ui/stations";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const view = await loadTraceView(getContext(), (await params).id);
  if (!view) return { title: "No trace here" };
  const t = view.trace;
  return {
    title: `${formatUsdc(t.amountAtomic)} USDC ${chainName(t.route.sourceChain)} to ${chainName(t.route.destinationChain)}`,
  };
}

const EVENT_WORDS: Record<string, string> = {
  burn: "USDC burned",
  message_sent: "Message sent",
  message_received: "Message received",
  mint: "USDC minted",
};

export default async function TracePage({ params }: Props) {
  const view = await loadTraceView(getContext(), (await params).id);
  if (!view) notFound();
  const t = view.trace;
  const amount = formatUsdc(t.amountAtomic);
  const flagged = t.reason === "FAILED" ? "fail" : t.reason === "STUCK" ? "stuck" : null;

  return (
    <article className="pt-14">
      <header>
        <p className="text-ink-soft">
          {chainName(t.route.sourceChain)} to {chainName(t.route.destinationChain)} over CCTP
          (domain {t.route.sourceDomain} to {t.route.destinationDomain})
        </p>
        <p className="mt-2 text-[clamp(2.75rem,7vw,4.75rem)] font-extrabold leading-none tracking-[-0.02em]">
          {amount}
          <span className="ml-3 text-[0.4em] font-bold tracking-normal text-ink-soft">USDC</span>
        </p>
        <h1
          className={cn(
            "mt-6 max-w-[40ch] text-2xl font-bold leading-snug sm:text-[1.75rem]",
            flagged === "fail" && "text-fail",
            flagged === "stuck" && "text-stuck",
          )}
        >
          {headline(view)}
        </h1>
        {flagged && t.statusReason && (
          <p
            className={cn(
              "mt-3 max-w-[72ch] rounded-sm px-3 py-2",
              flagged === "fail" ? "bg-fail-wash text-fail" : "bg-stuck-wash text-stuck",
            )}
          >
            {humanize(t.statusReason)}
          </p>
        )}
        <div className="mt-3">
          <LiveRefresh active={isLive(view)} />
        </div>
      </header>

      <section
        aria-label="Progress"
        className="mt-12 rounded-sm border border-rule bg-sheet px-5 py-8 sm:px-8"
      >
        <RouteRail stations={stationsFor(view)} />
      </section>

      <div className="mt-14 grid gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section aria-labelledby="checks">
          <h2 id="checks" className="text-xl font-bold">
            Checks
          </h2>
          <p className="mt-1 mb-4 text-sm text-ink-soft">
            Re-evaluated from the raw observations every time something new is seen.
          </p>
          <Checks invariants={view.invariants} />
        </section>

        <section aria-labelledby="parties">
          <h2 id="parties" className="text-xl font-bold">
            Transfer details
          </h2>
          <dl className="mt-4 divide-y divide-rule border-y border-rule">
            <Row term="Sender">{t.sender}</Row>
            <Row term="Recipient">{t.recipient}</Row>
            <Row term={`Burn on ${chainName(t.route.sourceChain)}`}>
              <a
                href={t.explorer.source}
                className="text-accent underline underline-offset-2"
                rel="noreferrer"
                target="_blank"
              >
                {shortHash(t.sourceTxHash, 10, 8)}
              </a>
              {t.sourceBlockTime && (
                <span className="block text-sm text-ink-soft">{formatUtc(t.sourceBlockTime)}</span>
              )}
            </Row>
            <Row term={`Mint on ${chainName(t.route.destinationChain)}`}>
              {t.destinationTxHash && t.explorer.destination ? (
                <a
                  href={t.explorer.destination}
                  className="text-accent underline underline-offset-2"
                  rel="noreferrer"
                  target="_blank"
                >
                  {shortHash(t.destinationTxHash, 10, 8)}
                </a>
              ) : (
                <span className="text-ink-soft">Not seen yet</span>
              )}
            </Row>
            <Row term="CCTP nonce">
              {t.nonce ?? <span className="text-ink-soft">Assigned when Circle signs</span>}
            </Row>
            {t.requireAppConfirmation && (
              <Row term="Your app">
                {t.applicationConfirmedAt ? (
                  <>
                    Confirmed {formatUtc(t.applicationConfirmedAt)}
                    {t.applicationReference && (
                      <span className="block text-sm text-ink-soft">
                        Reference {t.applicationReference}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-ink-soft">Waiting for confirmation</span>
                )}
              </Row>
            )}
          </dl>
        </section>
      </div>

      <Observations view={view} />
      <Evidence view={view} origin={await origin()} />
    </article>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <dt className="text-sm text-ink-soft">{term}</dt>
      <dd className="mt-1 min-w-0 break-all font-mono text-[0.875rem]">{children}</dd>
    </div>
  );
}

function Observations({ view }: { view: TraceView }) {
  const rows = [
    ...view.events.map((e) => ({
      key: `${e.chainId}:${e.txHash}:${e.logIndex}`,
      at: e.observedAt,
      what: EVENT_WORDS[e.eventType] ?? e.eventType,
      where:
        e.domain === view.trace.route.sourceDomain
          ? chainName(view.trace.route.sourceChain)
          : chainName(view.trace.route.destinationChain),
      ref: `block ${e.blockNumber}, log ${e.logIndex}`,
      url: e.explorerUrl,
      tx: e.txHash,
      removed: e.removed,
    })),
    ...view.attestations.map((a, i) => ({
      key: `iris-${i}`,
      at: a.observedAt,
      what:
        a.status === "complete"
          ? "Circle signed the message"
          : `Circle status: ${a.status.replaceAll("_", " ")}`,
      where: "Circle",
      ref: a.delayReason ? `delayed: ${a.delayReason}` : "attestation service",
      url: null,
      tx: null,
      removed: false,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <section aria-labelledby="observations" className="mt-16">
      <h2 id="observations" className="text-xl font-bold">
        What Sentinel saw
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        Every on-chain log and attestation response behind the verdict, in the order they were first
        seen.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-left">
          <thead className="border-b-2 border-ink text-sm">
            <tr>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Seen (UTC)
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                What
              </th>
              <th scope="col" className="py-2 pr-4 font-semibold">
                Where
              </th>
              <th scope="col" className="py-2 font-semibold">
                Source
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map((r) => (
              <tr key={r.key} className={cn(r.removed && "text-ink-soft line-through")}>
                <td className="py-2.5 pr-4 text-sm whitespace-nowrap">
                  {formatUtc(r.at).replace(" UTC", "")}
                </td>
                <td className="py-2.5 pr-4">
                  {r.what}
                  {r.removed && (
                    <span className="ml-2 text-sm no-underline">dropped by a chain reorg</span>
                  )}
                </td>
                <td className="py-2.5 pr-4">{r.where}</td>
                <td className="py-2.5 text-sm">
                  {r.url && r.tx ? (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-accent underline underline-offset-2"
                    >
                      {shortHash(r.tx)}
                    </a>
                  ) : null}{" "}
                  <span className="text-ink-soft">{r.ref}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

function Evidence({ view, origin }: { view: TraceView; origin: string }) {
  const t = view.trace;
  const suffix = view.latestEvidence ? `-${view.latestEvidence.keccak256.slice(2, 10)}` : "";
  const file = `sentinel-evidence-${t.id}${suffix}.json`;
  const command = `npx pnpm@10.18.3 --filter @sentinel/evidence verify-evidence ${file} --key-url ${origin}/.well-known/sentinel-key.json`;
  return (
    <section aria-labelledby="evidence" className="mt-16 border-t-2 border-ink pt-6">
      <h2 id="evidence" className="text-xl font-bold">
        Evidence
      </h2>
      {view.signingEnabled ? (
        <>
          <p className="mt-2 max-w-[68ch] text-ink-soft">
            A signed record of every observation and check above. Attach it to a support ticket or
            audit; anyone can verify it against this site&apos;s published signing key without
            trusting this page.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href={`/api/traces/${t.id}/evidence?download=1`}
              className="rounded-sm bg-ink px-5 py-2.5 font-semibold text-paper hover:brightness-125"
            >
              Download evidence
            </a>
            <a
              href={`/api/traces/${t.id}/evidence`}
              className="text-accent underline underline-offset-4"
            >
              View as JSON
            </a>
          </div>
          {view.latestEvidence && (
            <dl className="mt-6 max-w-3xl divide-y divide-rule border-y border-rule">
              <div className="grid gap-1 py-3 sm:grid-cols-[9.5rem_1fr] sm:gap-4">
                <dt className="text-sm text-ink-soft">Last sealed hash</dt>
                <dd className="break-all font-mono text-[0.85rem]">
                  {view.latestEvidence.keccak256}
                </dd>
              </div>
              <div className="grid gap-1 py-3 sm:grid-cols-[9.5rem_1fr] sm:gap-4">
                <dt className="text-sm text-ink-soft">Anchored on Arc</dt>
                <dd className="text-[0.95rem] text-ink-soft">
                  {view.latestEvidence.anchorTxHash ?? "Not anchored yet"}
                </dd>
              </div>
            </dl>
          )}
          <div className="mt-6 max-w-3xl">
            <p className="text-sm font-semibold">Verify it yourself</p>
            <div className="mt-2 flex items-start gap-2">
              <code className="block flex-1 overflow-x-auto rounded-sm border border-rule bg-sheet px-3 py-2 font-mono text-[0.8rem] whitespace-pre">
                {command}
              </code>
              <CopyButton text={command} />
            </div>
          </div>
        </>
      ) : (
        <p className="mt-2 text-ink-soft">
          Evidence signing is turned off on this deployment. Set EVIDENCE_SIGNING_KEY to enable
          downloads.
        </p>
      )}
    </section>
  );
}
