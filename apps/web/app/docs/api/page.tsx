import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Code } from "@/ui/api-docs/code";
import { Endpoint } from "@/ui/api-docs/endpoint";
import { EXAMPLE_TX } from "@/ui/api-docs/meta";
import { buildDocsModel } from "@/ui/api-docs/model";
import { requestOrigin } from "@/ui/origin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "API",
  description:
    "Trace CCTP transfers between Arc and Base, read checks and download signed evidence over HTTP.",
};

const LIFECYCLE: [string, string, string][] = [
  [
    "SOURCE_OBSERVED",
    "Burned",
    "The burn is on the source chain; Circle has not picked it up yet.",
  ],
  ["FINALITY_WAIT", "Finalizing", "Circle is waiting for the source chain to finalize the burn."],
  [
    "ATTESTATION_PENDING",
    "Awaiting signature",
    "The burn is final; Circle has not signed the message yet.",
  ],
  [
    "ATTESTED",
    "Signed",
    "Circle signed the message; anyone can now submit it on the destination chain.",
  ],
  [
    "DESTINATION_SUBMITTED",
    "Received",
    "The message arrived on the destination chain; the mint is not visible yet.",
  ],
  [
    "MINT_CONFIRMED",
    "Minted",
    "USDC was minted to the recipient. Final, unless your app must confirm.",
  ],
  ["APPLICATION_CONFIRMED", "Confirmed", "Your app confirmed it credited the funds."],
  [
    "FAILED_OR_STUCK",
    "Failed or stuck",
    'reason "STUCK": a step took longer than its limit (it recovers if the transfer continues). reason "FAILED": a safety check failed; final.',
  ],
];

const WEBHOOK_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the exact request body string, before JSON parsing.
export function verifySentinelWebhook(secret, headers, rawBody) {
  const ts = Number(headers["x-sentinel-timestamp"]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false; // replay window
  const expected = "v1=" + createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`).digest("hex");
  const given = String(headers["x-sentinel-signature"] ?? "");
  return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}`;

const WEBHOOK_EVENT = `{
  "id": "6c0f3b1e-…",
  "type": "trace.status_changed",
  "createdAt": "2026-10-12T11:18:39.000Z",
  "sequence": 3,
  "data": {
    "traceId": "4d73f21d-…",
    "status": "MINT_CONFIRMED",
    "previousStatus": "ATTESTED",
    "reason": null,
    "sourceTxHash": "0x2191…e41e",
    "destinationTxHash": "0x5281…ec39",
    "amountAtomic": "5869596",
    "invariants": { "value-conservation": "PASS", "…": "PASS" }
  }
}`;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6 pt-14">
      <h2 id={`${id}-h`} className="border-b-2 border-ink pb-2 text-2xl font-bold">
        {title}
      </h2>
      <div className="mt-4 max-w-[72ch] space-y-3 leading-relaxed">{children}</div>
    </section>
  );
}

export default async function ApiDocs() {
  const origin = await requestOrigin();
  const { groups } = buildDocsModel();
  const toc = [
    { id: "start", title: "Quick start" },
    { id: "basics", title: "Basics" },
    { id: "lifecycle", title: "Transfer status" },
    ...groups.map((g) => ({
      id: g.id,
      title: g.title,
      children: g.endpoints.map((e) => ({ id: e.id, title: e.title })),
    })),
    { id: "webhook-events", title: "Receiving webhooks" },
    { id: "verify-evidence", title: "Verifying evidence" },
  ];

  return (
    <div className="pt-14 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
      <nav
        aria-label="On this page"
        className="text-sm lg:sticky lg:top-6 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto"
      >
        <details className="rounded-sm border border-rule bg-sheet px-4 py-3 lg:hidden">
          <summary className="cursor-pointer font-semibold">On this page</summary>
          <Toc items={toc} />
        </details>
        <div className="hidden lg:block">
          <p className="font-semibold">On this page</p>
          <Toc items={toc} />
        </div>
      </nav>

      <article className="min-w-0">
        <header className="mt-10 lg:mt-0">
          <h1 className="text-[clamp(2.5rem,6vw,4rem)] font-extrabold leading-none tracking-[-0.03em]">
            API
          </h1>
          <p className="mt-5 max-w-[62ch] text-lg leading-relaxed text-ink-soft">
            Everything the site does is available over HTTP: trace a transfer, follow its status,
            read the safety checks, and download evidence you can verify yourself. JSON in, JSON
            out.
          </p>
          <p className="mt-3 text-sm text-ink-soft">
            For tools that read OpenAPI:{" "}
            <a href="/api/openapi.json" className="text-accent underline underline-offset-2">
              machine-readable OpenAPI 3.0
            </a>
            .
          </p>
        </header>

        <Section id="start" title="Quick start">
          <p>Set these once in your shell; every example on this page uses them.</p>
          <Code
            code={`export BASE="${origin}"
export API_KEY="<one of this deployment's API keys; only needed where marked>"`}
          />
          <p>Trace a real 41,300 USDC transfer from Arc to Base, then read it back:</p>
          <Code
            code={`TRACE_ID=$(curl -s -X POST "$BASE/api/traces" \\
  -H "content-type: application/json" \\
  -d '{"sourceTxHash":"${EXAMPLE_TX}","sourceChain":"arc"}' | jq -r '.traces[0].id')

curl "$BASE/api/traces/$TRACE_ID"`}
          />
          <p className="text-sm text-ink-soft">
            Within a few seconds the status reads MINT_CONFIRMED. The same trace is on the website
            at <span className="font-mono">/traces/$TRACE_ID</span>.
          </p>
        </Section>

        <Section id="basics" title="Basics">
          <h3 className="pt-2 font-bold">Who can call what</h3>
          <p>
            Reading traces, checks and evidence needs no key. Actions that change something on your
            behalf (confirming a trace, anchoring evidence, sending test webhooks, or creating a
            trace that waits for your confirmation) need an API key from the operator, sent as{" "}
            <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
          </p>
          <h3 className="pt-2 font-bold">Limits</h3>
          <p>
            Creating new traces without a key is rate limited, because each one costs blockchain
            reads. When you hit the limit you get <span className="font-mono">429</span> with a{" "}
            <span className="font-mono">Retry-After</span> header in seconds. Repeating a request
            for a transaction that is already traced is never limited.
          </p>
          <h3 className="pt-2 font-bold">Amounts and times</h3>
          <p>
            USDC amounts are strings of whole units at 6 decimals:{" "}
            <span className="font-mono">&quot;5869596&quot;</span> is 5.869596 USDC. They are
            strings so no client loses precision. Times are ISO 8601 in UTC.
          </p>
          <h3 className="pt-2 font-bold">Errors</h3>
          <p>
            Errors use one shape (RFC 7807,{" "}
            <span className="font-mono">application/problem+json</span>). Validation errors list
            each field; unexpected errors only return an id you can give the operator.
          </p>
          <Code
            copy={false}
            code={`{
  "type": "about:blank",
  "title": "Validation failed",
  "status": 400,
  "errors": [{ "path": "sourceChain", "message": "Invalid option: expected one of \\"base\\"|\\"arc\\"" }]
}`}
          />
        </Section>

        <Section id="lifecycle" title="Transfer status">
          <p>
            A trace&apos;s <span className="font-mono">status</span> is one of these, in order.
            Status only moves forward as evidence arrives;{" "}
            <span className="font-mono">progress</span> always holds the furthest step reached, even
            while the status is flagged.
          </p>
          <dl className="mt-2 divide-y divide-rule border-y border-rule">
            {LIFECYCLE.map(([code, word, meaning]) => (
              <div key={code} className="grid gap-1 py-2.5 sm:grid-cols-[14rem_1fr] sm:gap-4">
                <dt>
                  <span className="font-mono text-[0.85rem]">{code}</span>
                  <span className="block text-sm text-ink-soft">{word} on the website</span>
                </dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </Section>

        {groups.map((g) => (
          <section key={g.id} id={g.id} aria-labelledby={`${g.id}-h`} className="scroll-mt-6 pt-14">
            <h2 id={`${g.id}-h`} className="border-b-2 border-ink pb-2 text-2xl font-bold">
              {g.title}
            </h2>
            <p className="mt-4 mb-2 max-w-[72ch] text-ink-soft">{g.intro}</p>
            {g.endpoints.map((e) => (
              <Endpoint key={e.id} e={e} />
            ))}
          </section>
        ))}

        <Section id="webhook-events" title="Receiving webhooks">
          <p>
            If the operator registered your URL, Sentinel sends a POST every time a trace&apos;s
            status changes. Each request carries these headers:
          </p>
          <dl className="divide-y divide-rule border-y border-rule text-sm">
            {[
              ["x-sentinel-event-id", "Unique per event. Use it to ignore duplicates."],
              ["x-sentinel-event-type", "trace.status_changed, or webhook.test for test events."],
              [
                "x-sentinel-sequence",
                "Increases per trace. Ignore an event whose sequence is not higher than the last one you processed.",
              ],
              ["x-sentinel-timestamp", "Unix seconds when it was signed."],
              [
                "x-sentinel-retry",
                "0 on the first attempt, then 1, 2, … Failed deliveries are retried with backoff, up to 10 attempts.",
              ],
              [
                "x-sentinel-signature",
                'v1= followed by HMAC-SHA256 of "<timestamp>.<raw body>" with your shared secret.',
              ],
            ].map(([h, d]) => (
              <div key={h} className="grid gap-1 py-2.5 sm:grid-cols-[13rem_1fr] sm:gap-4">
                <dt className="font-mono text-[0.8rem]">{h}</dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
          <p>Verify every request before acting on it, and reply with any 2xx within 10 seconds:</p>
          <Code code={WEBHOOK_VERIFY} label="Node.js" />
          <Code code={WEBHOOK_EVENT} label="Example event" copy={false} />
        </Section>

        <Section id="verify-evidence" title="Verifying evidence">
          <p>
            An evidence file is a signed record of everything Sentinel observed for a trace and the
            verdict it reached. You don&apos;t have to trust this site to check it: the open-source
            verifier recomputes the file&apos;s hashes and checks its signature against the public
            signing key published at{" "}
            <a
              href="/.well-known/sentinel-key.json"
              className="font-mono text-accent underline underline-offset-2"
            >
              /.well-known/sentinel-key.json
            </a>
            .
          </p>
          <p>
            If the evidence was anchored, the verifier also reads the Arc transaction and confirms
            that the registry recorded this exact hash for this trace, from this site&apos;s
            account.
          </p>
          <Code
            code={`curl -OJ "$BASE/api/traces/$TRACE_ID/evidence?download=1"
npx pnpm@10.18.3 --filter @sentinel/evidence verify-evidence sentinel-evidence-*.json \\
  --key-url "$BASE/.well-known/sentinel-key.json" \\
  --anchor-tx <anchor transaction hash, if anchored>`}
          />
          <p className="text-sm text-ink-soft">
            Run it from a checkout of the ArcFlow Sentinel repository. Exit code 0 means valid, 1
            means it failed a check, 2 means it could not run.
          </p>
        </Section>
      </article>
    </div>
  );
}

type TocItem = { id: string; title: string; children?: { id: string; title: string }[] };

function Toc({ items }: { items: TocItem[] }) {
  return (
    <ul className="mt-3 space-y-2">
      {items.map((i) => (
        <li key={i.id}>
          <a href={`#${i.id}`} className="text-ink hover:text-accent">
            {i.title}
          </a>
          {i.children && (
            <ul className="mt-1.5 space-y-1 border-l border-rule pl-3">
              {i.children.map((c) => (
                <li key={c.id}>
                  <a href={`#${c.id}`} className="text-ink-soft hover:text-accent">
                    {c.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
