import type { Hex } from "viem";
import { toJsonSafe } from "./json.js";
import { bytes32ToAddress, type BurnMessageV2 } from "./message.js";
import { eventKey } from "./revive.js";
import type {
  AttestationObserved,
  BurnObserved,
  ChainEvent,
  DomainEvent,
  LifecycleState,
  MessageReceivedObserved,
  MessageSentObserved,
  MintObserved,
  StuckOrFailedReason,
} from "./types.js";

// ---- configuration ----------------------------------------------------------------------------

const MINUTE = 60_000;

/** Max time a trace may spend in each stage before it is reported STUCK (milliseconds). */
export interface StageDeadlines {
  /** SOURCE_OBSERVED: burn mined, Iris has not indexed it yet. */
  indexing: number;
  /** FINALITY_WAIT, by finality class; per-source-domain overrides below. */
  finality: { standard: number; fast: number };
  finalityBySourceDomain: Record<number, Partial<{ standard: number; fast: number }>>;
  /** ATTESTATION_PENDING: final, but not signed (e.g. delayReason set by Iris). */
  attestation: number;
  /** ATTESTED: signed, waiting for someone to call receiveMessage on the destination. */
  mint: number;
  /** DESTINATION_SUBMITTED: MessageReceived seen but no MintAndWithdraw in that tx. */
  mintEvent: number;
  /** MINT_CONFIRMED, when the trace requires application confirmation. */
  applicationConfirmation: number;
}

/**
 * Defaults, chosen to flag real problems rather than normal variance:
 * - Standard transfers wait for source-chain hard finality. Base (an OP-stack L2) reaches it
 *   in roughly 13-20 minutes, so 45 minutes leaves headroom. Arc finalizes in under a second,
 *   so Arc-sourced messages get 10 minutes.
 * - The mint is unbounded by protocol (anyone may relay) until the attestation expires
 *   (expirationBlock, ~24h). Two hours without a mint is operationally worth flagging.
 */
export const DEFAULT_DEADLINES: StageDeadlines = {
  indexing: 10 * MINUTE,
  finality: { standard: 45 * MINUTE, fast: 10 * MINUTE },
  finalityBySourceDomain: { 26: { standard: 10 * MINUTE } },
  attestation: 30 * MINUTE,
  mint: 120 * MINUTE,
  mintEvent: 10 * MINUTE,
  applicationConfirmation: 60 * MINUTE,
};

/** CCTP V2: minFinalityThreshold <= 1000 is a Fast transfer, 2000 is Standard. */
export const isFastTransfer = (minFinalityThreshold: number) => minFinalityThreshold <= 1000;

// ---- inputs / outputs -------------------------------------------------------------------------

export interface TraceContext {
  sourceDomain: number;
  destinationDomain: number;
  /** Identifies this trace's burn among the source events. */
  burn: { chainId: number; txHash: Hex; logIndex: number };
  /** Block time of the burn; falls back to firstSeenAt. */
  sourceBlockTime: Date | null;
  firstSeenAt: Date;
  requireApplicationConfirmation: boolean;
  applicationConfirmedAt: Date | null;
}

export type InvariantId =
  | "unique-completion"
  | "value-conservation"
  | "recipient-integrity"
  | "domain-integrity"
  | "progress-bound";

export interface InvariantResult {
  ruleId: InvariantId;
  result: "PASS" | "FAIL" | "UNKNOWN";
  explanation: string;
  /** Event keys (`chainId:txHash:logIndex`) or `iris:<ISO time>` observations relied on. */
  evidenceRefs: string[];
}

export interface LifecycleResult {
  /** Reported status: the progress stage, or FAILED_OR_STUCK when flagged. */
  status: LifecycleState;
  /** Furthest stage the evidence supports (never FAILED_OR_STUCK). */
  progress: LifecycleState;
  reason: StuckOrFailedReason | null;
  statusReason: string | null;
  nonce: Hex | null;
  destinationTxHash: Hex | null;
  stageEnteredAt: Date | null;
  deadlineAt: Date | null;
  /** No further evidence can change the outcome; stop polling. */
  terminal: boolean;
  invariants: InvariantResult[];
  /** Data-quality problems, e.g. two sources reporting different content for the same log. */
  anomalies: string[];
}

// ---- normalization ----------------------------------------------------------------------------

interface Normalized {
  burn: BurnObserved | null;
  messageSent: MessageSentObserved | null;
  attestations: AttestationObserved[];
  attested: AttestationObserved | null;
  received: MessageReceivedObserved[];
  mints: MintObserved[];
  anomalies: string[];
  conflicted: boolean;
}

const fingerprint = (e: ChainEvent) => {
  // observedAt and block placement are not content: the same log re-observed later (or moved by
  // a reorg) is still the same fact. Anything else differing means sources disagree.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { observedAt, blockNumber, blockHash, ...content } = e;
  return JSON.stringify(toJsonSafe(content));
};

const sameAddress32 = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

function matchesBurn(m: BurnMessageV2, burn: BurnObserved): boolean {
  return (
    m.destinationDomain === burn.destinationDomain &&
    m.body.amount === burn.amount &&
    sameAddress32(m.body.mintRecipient, burn.mintRecipient)
  );
}

/**
 * Dedupes by log identity, orders canonically, and selects the evidence relevant to this trace.
 * Everything downstream depends only on the resulting sets, which makes the reducer independent
 * of input order and duplication.
 */
function normalize(ctx: TraceContext, input: readonly DomainEvent[]): Normalized {
  const anomalies: string[] = [];
  let conflicted = false;
  const chain = new Map<string, ChainEvent>();
  const attestations: AttestationObserved[] = [];

  for (const e of input) {
    if (e.kind === "attestation") {
      attestations.push(e);
      continue;
    }
    const key = eventKey(e);
    const prev = chain.get(key);
    if (!prev) chain.set(key, e);
    else if (fingerprint(prev) !== fingerprint(e)) {
      conflicted = true;
      anomalies.push(`conflicting observations for log ${key}`);
    } else if (e.observedAt && (!prev.observedAt || e.observedAt < prev.observedAt)) {
      chain.set(key, e); // keep the earliest observation time
    }
  }

  const events = [...chain.values()].sort(
    (a, b) =>
      a.chainId - b.chainId ||
      (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0) ||
      a.logIndex - b.logIndex,
  );
  attestations.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  const burn =
    (events.find(
      (e) =>
        e.kind === "burn" &&
        e.chainId === ctx.burn.chainId &&
        e.txHash.toLowerCase() === ctx.burn.txHash.toLowerCase() &&
        e.logIndex === ctx.burn.logIndex,
    ) as BurnObserved | undefined) ?? null;

  // TokenMessengerV2 emits the burn's MessageSent immediately before DepositForBurn.
  const messageSent = burn
    ? ((events
        .filter(
          (e) =>
            e.kind === "message_sent" &&
            e.chainId === burn.chainId &&
            e.txHash.toLowerCase() === burn.txHash.toLowerCase() &&
            e.logIndex < burn.logIndex,
        )
        .at(-1) as MessageSentObserved | undefined) ?? null)
    : null;

  // Prefer Iris messages that match this burn (a tx can hold several burns). If none match,
  // keep them all: a mismatching attested message is exactly what the invariants must catch,
  // so it must not be filtered away as "not ours".
  const matching = burn
    ? attestations.filter((a) => !a.message || matchesBurn(a.message, burn))
    : attestations;
  const relevant = matching.some((a) => a.message) ? matching : attestations;
  const attested =
    relevant.find((a) => a.status === "complete" && a.nonce && a.attestation && a.message) ?? null;

  const nonce = attested?.nonce?.toLowerCase();
  const received = nonce
    ? (events.filter(
        (e) =>
          e.kind === "message_received" &&
          e.domain === ctx.destinationDomain &&
          e.nonce.toLowerCase() === nonce,
      ) as MessageReceivedObserved[])
    : [];
  const receivedTxs = new Set(received.map((r) => `${r.chainId}:${r.txHash.toLowerCase()}`));
  const mints = events.filter(
    (e) => e.kind === "mint" && receivedTxs.has(`${e.chainId}:${e.txHash.toLowerCase()}`),
  ) as MintObserved[];

  return {
    burn,
    messageSent,
    attestations: relevant,
    attested,
    received,
    mints,
    anomalies,
    conflicted,
  };
}

// ---- invariants -------------------------------------------------------------------------------

const ref = (e: ChainEvent) => eventKey(e);
const irisRef = (a: AttestationObserved) => `iris:${a.observedAt.toISOString()}`;
const result = (
  ruleId: InvariantId,
  r: InvariantResult["result"],
  explanation: string,
  evidenceRefs: string[],
): InvariantResult => ({ ruleId, result: r, explanation, evidenceRefs });

function uniqueCompletion(n: Normalized): InvariantResult {
  const refs = [...n.received.map(ref), ...n.mints.map(ref)];
  if (n.received.length > 1 || n.mints.length > 1) {
    return result(
      "unique-completion",
      "FAIL",
      `nonce completed ${n.received.length} times with ${n.mints.length} mints; expected exactly one`,
      refs,
    );
  }
  if (n.received.length === 0) {
    return result("unique-completion", "UNKNOWN", "no destination completion observed yet", refs);
  }
  return result("unique-completion", "PASS", "exactly one destination completion", refs);
}

function valueConservation(n: Normalized): InvariantResult {
  const { burn, messageSent, attested } = n;
  if (!burn) return result("value-conservation", "UNKNOWN", "source burn not observed", []);
  const refs = [ref(burn)];
  const fail = (why: string) => result("value-conservation", "FAIL", why, refs);

  if (messageSent) {
    refs.push(ref(messageSent));
    if (messageSent.message.body.amount !== burn.amount) {
      return fail(`MessageSent amount ${messageSent.message.body.amount} != burn ${burn.amount}`);
    }
  }
  if (!attested?.message) {
    return result("value-conservation", "UNKNOWN", "waiting for attested message", refs);
  }
  refs.push(irisRef(attested));
  const body = attested.message.body;
  if (body.amount !== burn.amount)
    return fail(`attested amount ${body.amount} != burn ${burn.amount}`);
  if (body.feeExecuted > burn.maxFee) {
    return fail(`feeExecuted ${body.feeExecuted} exceeds maxFee ${burn.maxFee}`);
  }
  const [mint] = n.mints;
  if (!mint) {
    return result(
      "value-conservation",
      "UNKNOWN",
      `attested ${body.amount} with fee ${body.feeExecuted}; mint not observed yet`,
      refs,
    );
  }
  refs.push(ref(mint));
  if (mint.feeCollected !== body.feeExecuted) {
    return fail(
      `mint feeCollected ${mint.feeCollected} != attested feeExecuted ${body.feeExecuted}`,
    );
  }
  if (mint.amount + mint.feeCollected !== burn.amount) {
    return fail(`minted ${mint.amount} + fee ${mint.feeCollected} != burned ${burn.amount}`);
  }
  return result(
    "value-conservation",
    "PASS",
    `burned ${burn.amount} = minted ${mint.amount} + fee ${mint.feeCollected}`,
    refs,
  );
}

function recipientIntegrity(n: Normalized): InvariantResult {
  const { burn, messageSent, attested } = n;
  if (!burn) return result("recipient-integrity", "UNKNOWN", "source burn not observed", []);
  const refs = [ref(burn)];
  const expected = burn.mintRecipient;
  const fail = (why: string) => result("recipient-integrity", "FAIL", why, refs);

  if (messageSent) {
    refs.push(ref(messageSent));
    if (!sameAddress32(messageSent.message.body.mintRecipient, expected)) {
      return fail("MessageSent mintRecipient differs from the burn");
    }
  }
  if (attested?.message) {
    refs.push(irisRef(attested));
    if (!sameAddress32(attested.message.body.mintRecipient, expected)) {
      return fail("attested mintRecipient differs from the burn");
    }
  }
  const [mint] = n.mints;
  if (!mint) {
    return result("recipient-integrity", "UNKNOWN", "mint not observed yet", refs);
  }
  refs.push(ref(mint));
  let expectedAddress;
  try {
    expectedAddress = bytes32ToAddress(expected);
  } catch {
    return fail(`burn mintRecipient ${expected} is not an EVM address`);
  }
  if (mint.mintRecipient.toLowerCase() !== expectedAddress.toLowerCase()) {
    return fail(`minted to ${mint.mintRecipient}, burn specified ${expectedAddress}`);
  }
  return result(
    "recipient-integrity",
    "PASS",
    `minted to ${mint.mintRecipient} as specified`,
    refs,
  );
}

function domainIntegrity(ctx: TraceContext, n: Normalized): InvariantResult {
  const { burn, messageSent, attested } = n;
  if (!burn) return result("domain-integrity", "UNKNOWN", "source burn not observed", []);
  const refs = [ref(burn)];
  const route = `${ctx.sourceDomain}->${ctx.destinationDomain}`;
  const check = (label: string, src: number, dst: number) =>
    src === ctx.sourceDomain && dst === ctx.destinationDomain
      ? null
      : `${label} route ${src}->${dst} != expected ${route}`;

  const problems = [check("burn", burn.domain, burn.destinationDomain)];
  if (messageSent) {
    refs.push(ref(messageSent));
    problems.push(
      check("MessageSent", messageSent.message.sourceDomain, messageSent.message.destinationDomain),
    );
  }
  if (attested?.message) {
    refs.push(irisRef(attested));
    problems.push(
      check("attested", attested.message.sourceDomain, attested.message.destinationDomain),
    );
  }
  for (const r of n.received) {
    refs.push(ref(r));
    problems.push(check("MessageReceived", r.sourceDomain, r.domain));
  }
  const problem = problems.find(Boolean);
  if (problem) return result("domain-integrity", "FAIL", problem, refs);
  return result(
    "domain-integrity",
    n.received.length ? "PASS" : "UNKNOWN",
    n.received.length ? `all observations on route ${route}` : `consistent so far on ${route}`,
    refs,
  );
}

// ---- reducer ----------------------------------------------------------------------------------

interface Progress {
  state: LifecycleState;
  enteredAt: Date | null;
  deadlineMs: number | null;
  note: string | null;
}

function progressOf(ctx: TraceContext, n: Normalized, deadlines: StageDeadlines): Progress {
  const sourceTime = ctx.sourceBlockTime ?? ctx.firstSeenAt;

  if (ctx.applicationConfirmedAt && n.mints.length > 0) {
    return {
      state: "APPLICATION_CONFIRMED",
      enteredAt: ctx.applicationConfirmedAt,
      deadlineMs: null,
      note: null,
    };
  }
  if (n.mints.length > 0) {
    const mintedAt = n.mints[0]!.observedAt ?? null;
    return {
      state: "MINT_CONFIRMED",
      enteredAt: mintedAt,
      deadlineMs: ctx.requireApplicationConfirmation ? deadlines.applicationConfirmation : null,
      note: null,
    };
  }
  if (n.received.length > 0) {
    return {
      state: "DESTINATION_SUBMITTED",
      enteredAt: n.received[0]!.observedAt ?? null,
      deadlineMs: deadlines.mintEvent,
      note: "MessageReceived observed without MintAndWithdraw",
    };
  }
  if (n.attested) {
    return {
      state: "ATTESTED",
      enteredAt: n.attested.observedAt,
      deadlineMs: deadlines.mint,
      note: null,
    };
  }
  const delayed = n.attestations.find((a) => a.delayReason);
  const completeUnsigned = n.attestations.find((a) => a.status === "complete");
  if (delayed || completeUnsigned) {
    const a = (delayed ?? completeUnsigned)!;
    return {
      state: "ATTESTATION_PENDING",
      enteredAt: a.observedAt,
      deadlineMs: deadlines.attestation,
      note: a.delayReason ? `Iris delayReason: ${a.delayReason}` : null,
    };
  }
  if (n.attestations.length > 0) {
    const threshold = n.burn?.minFinalityThreshold ?? 2000;
    const cls = isFastTransfer(threshold) ? "fast" : "standard";
    const override = deadlines.finalityBySourceDomain[ctx.sourceDomain]?.[cls];
    return {
      state: "FINALITY_WAIT",
      // Finality is measured from the burn, not from when Iris first answered.
      enteredAt: sourceTime,
      deadlineMs: override ?? deadlines.finality[cls],
      note: null,
    };
  }
  return {
    state: "SOURCE_OBSERVED",
    enteredAt: sourceTime,
    deadlineMs: deadlines.indexing,
    note: null,
  };
}

function progressBound(p: Progress, now: Date): { inv: InvariantResult; deadlineAt: Date | null } {
  if (p.deadlineMs === null || !p.enteredAt) {
    const done = p.deadlineMs === null;
    return {
      inv: result(
        "progress-bound",
        done ? "PASS" : "UNKNOWN",
        done ? `${p.state} has no deadline` : `entry time of ${p.state} unknown`,
        [],
      ),
      deadlineAt: null,
    };
  }
  const deadlineAt = new Date(p.enteredAt.getTime() + p.deadlineMs);
  const minutes = (ms: number) => `${Math.round(ms / MINUTE)}m`;
  if (now > deadlineAt) {
    return {
      inv: result(
        "progress-bound",
        "FAIL",
        `${p.state} for ${minutes(now.getTime() - p.enteredAt.getTime())} (limit ${minutes(p.deadlineMs)})`,
        [],
      ),
      deadlineAt,
    };
  }
  return {
    inv: result("progress-bound", "PASS", `${p.state} within ${minutes(p.deadlineMs)} limit`, []),
    deadlineAt,
  };
}

/**
 * Pure lifecycle reducer: derives status, invariant results and deadlines from the full set of
 * observations. The result depends only on the deduplicated evidence set (not on input order or
 * repetition), and adding evidence never moves `progress` backwards. Removing evidence (a reorg)
 * legitimately can.
 */
export function reduceLifecycle(
  ctx: TraceContext,
  events: readonly DomainEvent[],
  now: Date,
  deadlines: StageDeadlines = DEFAULT_DEADLINES,
): LifecycleResult {
  const n = normalize(ctx, events);
  const p = progressOf(ctx, n, deadlines);
  const bound = progressBound(p, now);

  let integrity = [
    uniqueCompletion(n),
    valueConservation(n),
    recipientIntegrity(n),
    domainIntegrity(ctx, n),
  ];
  if (n.conflicted) {
    // Sources disagree about the same log: neither version is trustworthy evidence.
    integrity = integrity.map((i) => ({
      ...i,
      result: "UNKNOWN" as const,
      explanation: `conflicting observations; ${i.explanation}`,
    }));
  }
  const invariants = [...integrity, bound.inv];

  const failed = integrity.find((i) => i.result === "FAIL");
  const stuck = bound.inv.result === "FAIL";
  const terminalSuccess =
    p.state === "APPLICATION_CONFIRMED" ||
    (p.state === "MINT_CONFIRMED" && !ctx.requireApplicationConfirmation);

  return {
    status: failed || stuck ? "FAILED_OR_STUCK" : p.state,
    progress: p.state,
    reason: failed ? "FAILED" : stuck ? "STUCK" : null,
    statusReason: failed
      ? `${failed.ruleId}: ${failed.explanation}`
      : stuck
        ? bound.inv.explanation
        : (p.note ?? (n.anomalies[0] || null)),
    nonce: n.attested?.nonce ?? null,
    destinationTxHash: n.received[0]?.txHash ?? null,
    stageEnteredAt: p.enteredAt,
    deadlineAt: bound.deadlineAt,
    // A failure is final evidence; success is final once nothing else is expected. STUCK is not
    // terminal: progress may still arrive.
    terminal: Boolean(failed) || terminalSuccess,
    invariants,
    anomalies: n.anomalies,
  };
}
