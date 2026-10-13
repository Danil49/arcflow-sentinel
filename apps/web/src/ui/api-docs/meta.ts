/**
 * Human-facing additions to the OpenAPI document: grouping, plain-language descriptions and
 * example calls. Keyed by "METHOD path"; test/api-docs.test.ts fails if an API operation has no
 * entry here, so the docs page cannot silently drift from the API.
 */
export const EXAMPLE_TX = "0xf2b45ee11be4e44ba04a9b5cb0aee99c1cb7a0b4bca42814bd146feb198c5432";

export const GROUPS = [
  {
    id: "traces",
    title: "Traces",
    intro: "Start tracing a transfer and read what Sentinel knows about it.",
  },
  {
    id: "evidence",
    title: "Evidence and anchoring",
    intro: "Download signed evidence, anchor its hash on Arc, and fetch the key to verify it.",
  },
  {
    id: "application",
    title: "Your application",
    intro: "Tell Sentinel when your app has credited the funds, for traces that wait for you.",
  },
  {
    id: "webhooks",
    title: "Webhooks",
    intro: "Check that your webhook endpoint receives and verifies events.",
  },
  { id: "health", title: "Health", intro: "For load balancers, uptime checks and on-call." },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

export interface EndpointMeta {
  group: GroupId;
  title: string;
  description: string;
  /** JSON body for the example call. */
  body?: unknown;
  /** Query string for the example call (without "?"). */
  query?: string;
  /** What specific status codes mean for this endpoint, when the generic meaning is not enough. */
  statusNotes?: Record<string, string>;
}

export const ENDPOINT_META: Record<string, EndpointMeta> = {
  "POST /api/traces": {
    group: "traces",
    title: "Trace a transfer",
    description:
      "Give Sentinel the transaction that burned USDC on Base or Arc. It reads the burn from the chain and starts following it to the mint. Safe to repeat: the same transaction always returns the same trace.",
    body: { sourceTxHash: EXAMPLE_TX, sourceChain: "arc" },
    statusNotes: {
      "200": "This transaction was already traced; the existing trace is returned.",
      "201": "New trace created; Sentinel is now following it.",
      "401": "requireAppConfirmation was set without a valid API key.",
      "422": "The transaction has no CCTP V2 burn on this route (Base ↔ Arc).",
      "429": "Too many new traces from you or overall; wait for Retry-After or use an API key.",
    },
  },
  "GET /api/traces": {
    group: "traces",
    title: "Find a trace by transaction",
    description:
      "Look up the trace for a burn transaction you already submitted. Never touches the chains.",
    query: `sourceTxHash=${EXAMPLE_TX}&sourceChain=arc`,
  },
  "GET /api/traces/{id}": {
    group: "traces",
    title: "Get a trace",
    description:
      "Status, progress, both transactions, the nonce, the amount and where the transfer stands against its deadlines.",
  },
  "GET /api/traces/{id}/events": {
    group: "traces",
    title: "List observations",
    description:
      "Every on-chain log and attestation response behind the verdict, including logs later dropped by a chain reorganization (marked removed).",
  },
  "GET /api/traces/{id}/invariants": {
    group: "traces",
    title: "List checks",
    description:
      "The five safety checks (delivered once, amount preserved, recipient unchanged, correct route, on schedule) with their result and explanation.",
  },
  "GET /api/traces/{id}/evidence": {
    group: "evidence",
    title: "Download evidence",
    description:
      "A signed, self-contained record of the trace. The same evidence always produces the same file and hash. Add ?download=1 to receive it as a file.",
  },
  "POST /api/traces/{id}/anchor": {
    group: "evidence",
    title: "Anchor evidence on Arc",
    description:
      "Writes the evidence hash to the EvidenceRegistry contract on Arc, so anyone can later prove the evidence existed at that time. Queued; the trace page shows the anchor within seconds.",
    statusNotes: { "409": "Anchoring is turned off or not configured on this deployment." },
  },
  "GET /.well-known/sentinel-key.json": {
    group: "evidence",
    title: "Get the signing key",
    description:
      "The public key that signs this site's evidence, plus where anchors live (network, chain id, registry, submitter). Verifiers use this, not the key inside a file.",
  },
  "POST /api/traces/{id}/confirm": {
    group: "application",
    title: "Confirm you credited the funds",
    description:
      "For traces created with requireAppConfirmation: call this once your app has credited the user. The trace moves from Minted to Confirmed. Idempotent; the first reference is kept.",
    body: { reference: "order-42" },
    statusNotes: { "409": "This trace was not created with requireAppConfirmation." },
  },
  "POST /api/webhooks/test": {
    group: "webhooks",
    title: "Send a test event",
    description:
      "Sends a signed webhook.test event to every configured endpoint, so you can check your receiver.",
    statusNotes: { "409": "No webhook endpoints are configured (WEBHOOK_URLS)." },
  },
  "GET /api/health/live": {
    group: "health",
    title: "Liveness",
    description: "The web process is up. Use it for container restarts.",
  },
  "GET /api/health/ready": {
    group: "health",
    title: "Readiness",
    description: "The database answers. Use it to decide whether to send traffic here.",
  },
  "GET /api/health/routes": {
    group: "health",
    title: "Route health",
    description:
      "Whether Arc, Base and Circle's attestation service are reachable right now. Cached for 15 seconds.",
  },
};

/** Generic meaning of status codes, in user terms. */
export const STATUS_WORDS: Record<string, string> = {
  "200": "OK",
  "201": "Created",
  "202": "Accepted, processing in the background",
  "400": "The request is malformed; the response lists the fields",
  "401": "API key missing or wrong",
  "404": "No such trace",
  "409": "Not possible in the current configuration",
  "415": "Send Content-Type: application/json",
  "422": "Understood, but cannot be processed",
  "429": "Rate limited; retry after the Retry-After header",
  "500": "Unexpected error; the response contains an error id for the operator",
  "503": "Unavailable or degraded",
};
