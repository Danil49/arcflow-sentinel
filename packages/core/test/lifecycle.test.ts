import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  DEFAULT_DEADLINES,
  LIFECYCLE_STATES,
  decodeCctpLogs,
  fromRpcLog,
  parseIrisMessages,
  reduceLifecycle,
  type AttestationObserved,
  type ChainEvent,
  type DomainEvent,
  type IrisMessagesResponse,
  type LifecycleState,
  type MintObserved,
  type RpcLog,
  type TraceContext,
} from "../src/index.js";
import { loadFixture, MESSAGE_TRANSMITTER, TOKEN_MESSENGER } from "./fixtures.js";

const MIN = 60_000;
const T0 = new Date("2026-10-07T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

interface Scenario {
  ctx: TraceContext;
  burn: Extract<ChainEvent, { kind: "burn" }>;
  sent: Extract<ChainEvent, { kind: "message_sent" }>;
  pending: AttestationObserved;
  attested: AttestationObserved;
  received: Extract<ChainEvent, { kind: "message_received" }>;
  mint: MintObserved;
  all: DomainEvent[];
}

function scenario(
  dir: string,
  src: { chainId: number; domain: number },
  dst: { chainId: number; domain: number },
): Scenario {
  const decode = (file: string, c: typeof src) =>
    decodeCctpLogs(
      loadFixture<{ logs: RpcLog[] }>(`${dir}/${file}`).logs.map((l) => fromRpcLog(l, c.chainId)),
      {
        domain: c.domain,
        tokenMessenger: TOKEN_MESSENGER,
        messageTransmitter: MESSAGE_TRANSMITTER,
      },
    );
  const sourceEvents = decode("source-receipt.json", src);
  const destEvents = decode("destination-receipt.json", dst).map((e) => ({
    ...e,
    observedAt: at(25),
  }));
  const burn = sourceEvents.find((e) => e.kind === "burn")!;
  const sent = sourceEvents.find((e) => e.kind === "message_sent")!;
  const iris = loadFixture<IrisMessagesResponse>(`${dir}/iris-messages.json`);
  const [attested] = parseIrisMessages(iris, src.domain, burn.txHash, at(20));
  const [pending] = parseIrisMessages(
    { messages: [{ status: "pending_confirmations", attestation: "PENDING", message: "0x" }] },
    src.domain,
    burn.txHash,
    at(1),
  );
  const ctx: TraceContext = {
    sourceDomain: src.domain,
    destinationDomain: dst.domain,
    burn: { chainId: burn.chainId, txHash: burn.txHash, logIndex: burn.logIndex },
    sourceBlockTime: T0,
    firstSeenAt: T0,
    requireApplicationConfirmation: false,
    applicationConfirmedAt: null,
  };
  return {
    ctx,
    burn,
    sent,
    pending: pending!,
    attested: attested!,
    received: destEvents.find((e) => e.kind === "message_received")!,
    mint: destEvents.find((e) => e.kind === "mint")!,
    all: [...sourceEvents, pending!, attested!, ...destEvents],
  };
}

const BASE = { chainId: 8453, domain: 6 };
const ARC = { chainId: 5042, domain: 26 };
const b2a = scenario("base-to-arc-complete", BASE, ARC);
const a2b = scenario("arc-to-base-complete", ARC, BASE);

const inv = (r: ReturnType<typeof reduceLifecycle>, id: string) =>
  r.invariants.find((i) => i.ruleId === id)!;
const rank = (s: LifecycleState) => LIFECYCLE_STATES.indexOf(s);

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("reduceLifecycle: real transfers", () => {
  it.each([
    ["Base→Arc", b2a],
    ["Arc→Base", a2b],
  ])("%s complete transfer is MINT_CONFIRMED with every invariant passing", (_, s) => {
    const r = reduceLifecycle(s.ctx, s.all, at(30));
    expect(r).toMatchObject({
      status: "MINT_CONFIRMED",
      reason: null,
      terminal: true,
      anomalies: [],
    });
    expect(r.nonce).toBe(s.attested.nonce);
    expect(r.destinationTxHash).toBe(s.received.txHash);
    expect(r.invariants.map((i) => i.result)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS"]);
  });
});

describe("reduceLifecycle: progress and deadlines", () => {
  const { ctx, burn, sent, pending, attested, received, mint } = b2a;

  it("source only, before Iris indexes it: SOURCE_OBSERVED within deadline", () => {
    const r = reduceLifecycle(ctx, [burn, sent], at(5));
    expect(r).toMatchObject({ status: "SOURCE_OBSERVED", terminal: false, deadlineAt: at(10) });
    expect(inv(r, "progress-bound").result).toBe("PASS");
    expect(inv(r, "unique-completion").result).toBe("UNKNOWN");
  });

  it("not indexed after 10 minutes: STUCK, not FAILED", () => {
    const r = reduceLifecycle(ctx, [burn, sent], at(11));
    expect(r).toMatchObject({
      status: "FAILED_OR_STUCK",
      progress: "SOURCE_OBSERVED",
      reason: "STUCK",
      terminal: false,
    });
  });

  it("pending confirmations: FINALITY_WAIT measured from the burn (Base standard: 45m)", () => {
    expect(reduceLifecycle(ctx, [burn, sent, pending], at(30)).status).toBe("FINALITY_WAIT");
    const late = reduceLifecycle(ctx, [burn, sent, pending], at(46));
    expect(late).toMatchObject({
      status: "FAILED_OR_STUCK",
      reason: "STUCK",
      progress: "FINALITY_WAIT",
    });
  });

  it("Arc-sourced standard transfers get the shorter Arc finality deadline", () => {
    const s = a2b;
    expect(reduceLifecycle(s.ctx, [s.burn, s.sent, s.pending], at(11)).reason).toBe("STUCK");
  });

  it("fast transfers (threshold <= 1000) use the fast finality deadline", () => {
    const fast = { ...burn, minFinalityThreshold: 1000 };
    expect(reduceLifecycle(ctx, [fast, sent, pending], at(11)).reason).toBe("STUCK");
  });

  it("Iris delayReason: ATTESTATION_PENDING with the reason surfaced", () => {
    const delayed = {
      ...pending,
      status: "pending_confirmations",
      delayReason: "insufficient_fee",
    };
    const r = reduceLifecycle(ctx, [burn, sent, delayed], at(5));
    expect(r).toMatchObject({
      status: "ATTESTATION_PENDING",
      statusReason: "Iris delayReason: insufficient_fee",
    });
  });

  it("attested without mint: ATTESTED, completion UNKNOWN, 2h mint deadline", () => {
    const r = reduceLifecycle(ctx, [burn, sent, pending, attested], at(60));
    expect(r).toMatchObject({ status: "ATTESTED", deadlineAt: at(140), terminal: false });
    expect(inv(r, "value-conservation").result).toBe("UNKNOWN");
    expect(reduceLifecycle(ctx, [burn, sent, pending, attested], at(141)).reason).toBe("STUCK");
  });

  it("missing mint event after MessageReceived: DESTINATION_SUBMITTED, then STUCK", () => {
    const r = reduceLifecycle(ctx, [burn, sent, attested, received], at(30));
    expect(r).toMatchObject({
      status: "DESTINATION_SUBMITTED",
      statusReason: expect.stringContaining("without MintAndWithdraw"),
    });
    expect(reduceLifecycle(ctx, [burn, sent, attested, received], at(36)).reason).toBe("STUCK");
  });

  it("a STUCK trace recovers when the mint finally arrives", () => {
    expect(reduceLifecycle(ctx, [burn, sent, attested], at(200)).reason).toBe("STUCK");
    const r = reduceLifecycle(ctx, [burn, sent, attested, received, mint], at(201));
    expect(r).toMatchObject({ status: "MINT_CONFIRMED", reason: null, terminal: true });
  });

  it("application confirmation: MINT_CONFIRMED waits for it, then APPLICATION_CONFIRMED", () => {
    const need = { ...ctx, requireApplicationConfirmation: true };
    const waiting = reduceLifecycle(need, b2a.all, at(30));
    expect(waiting).toMatchObject({
      status: "MINT_CONFIRMED",
      terminal: false,
      deadlineAt: at(85),
    });
    expect(reduceLifecycle(need, b2a.all, at(90)).reason).toBe("STUCK");
    const done = reduceLifecycle({ ...need, applicationConfirmedAt: at(40) }, b2a.all, at(90));
    expect(done).toMatchObject({ status: "APPLICATION_CONFIRMED", terminal: true });
  });

  it("an application confirmation without a mint does not skip ahead", () => {
    const r = reduceLifecycle({ ...ctx, applicationConfirmedAt: at(1) }, [burn, sent], at(2));
    expect(r.progress).toBe("SOURCE_OBSERVED");
  });
});

describe("reduceLifecycle: determinism", () => {
  const base = reduceLifecycle(b2a.ctx, b2a.all, at(30));

  it("duplicate observations do not change the result", () => {
    expect(reduceLifecycle(b2a.ctx, [...b2a.all, ...b2a.all, b2a.mint], at(30))).toEqual(base);
  });

  it("out-of-order delivery does not change the result", () => {
    for (let seed = 1; seed <= 25; seed++) {
      expect(reduceLifecycle(b2a.ctx, shuffle(b2a.all, seed), at(30))).toEqual(base);
    }
  });

  it("adding evidence never moves progress backwards", () => {
    const ordered: DomainEvent[] = [
      b2a.burn,
      b2a.sent,
      b2a.pending,
      b2a.attested,
      b2a.received,
      b2a.mint,
    ];
    let prev = -1;
    for (let i = 1; i <= ordered.length; i++) {
      const r = reduceLifecycle(b2a.ctx, ordered.slice(0, i), at(5));
      expect(rank(r.progress)).toBeGreaterThanOrEqual(prev);
      prev = rank(r.progress);
    }
    expect(LIFECYCLE_STATES[prev]).toBe("MINT_CONFIRMED");
  });

  it("ignores destination events for other nonces", () => {
    const foreign = {
      ...b2a.received,
      nonce: `0x${"99".repeat(32)}` as Hex,
      txHash: `0x${"98".repeat(32)}` as Hex,
    };
    const r = reduceLifecycle(b2a.ctx, [b2a.burn, b2a.sent, b2a.attested, foreign], at(30));
    expect(r.status).toBe("ATTESTED");
  });
});

describe("reduceLifecycle: invariant violations", () => {
  const { ctx, burn, sent, attested, received, mint } = b2a;
  const withMint = (m: Partial<MintObserved>) => [
    burn,
    sent,
    attested,
    received,
    { ...mint, ...m },
  ];

  it("wrong recipient: FAILED by recipient-integrity", () => {
    const r = reduceLifecycle(
      ctx,
      withMint({ mintRecipient: "0x000000000000000000000000000000000000bEEF" }),
      at(30),
    );
    expect(r).toMatchObject({ status: "FAILED_OR_STUCK", reason: "FAILED", terminal: true });
    expect(inv(r, "recipient-integrity").result).toBe("FAIL");
    expect(r.statusReason).toMatch(/^recipient-integrity/);
  });

  it("amount mismatch at the mint: FAILED by value-conservation", () => {
    const r = reduceLifecycle(ctx, withMint({ amount: mint.amount - 1n }), at(30));
    expect(inv(r, "value-conservation")).toMatchObject({
      result: "FAIL",
      explanation: expect.stringContaining("!= burned"),
    });
    expect(r.reason).toBe("FAILED");
  });

  it("attested amount differing from the burn is caught, not filtered out", () => {
    const tampered: AttestationObserved = {
      ...attested,
      message: {
        ...attested.message!,
        body: { ...attested.message!.body, amount: burn.amount + 1n },
      },
    };
    const r = reduceLifecycle(ctx, [burn, sent, tampered], at(30));
    expect(inv(r, "value-conservation").result).toBe("FAIL");
  });

  it("fees: an explicit fee within maxFee passes; feeExecuted above maxFee fails", () => {
    const fee = 1_000n;
    const feeBurn = { ...burn, maxFee: 5_000n };
    const feeAttested: AttestationObserved = {
      ...attested,
      message: { ...attested.message!, body: { ...attested.message!.body, feeExecuted: fee } },
    };
    const feeMint = { ...mint, amount: burn.amount - fee, feeCollected: fee };
    const ok = reduceLifecycle(ctx, [feeBurn, sent, feeAttested, received, feeMint], at(30));
    expect(inv(ok, "value-conservation")).toMatchObject({ result: "PASS" });
    expect(ok.status).toBe("MINT_CONFIRMED");

    const over = reduceLifecycle(
      ctx,
      [{ ...feeBurn, maxFee: fee - 1n }, sent, feeAttested, received, feeMint],
      at(30),
    );
    expect(inv(over, "value-conservation")).toMatchObject({
      result: "FAIL",
      explanation: expect.stringContaining("exceeds maxFee"),
    });
  });

  it("duplicate completion of one nonce: FAILED by unique-completion", () => {
    const tx2 = `0x${"77".repeat(32)}` as Hex;
    const r = reduceLifecycle(
      ctx,
      [...b2a.all, { ...received, txHash: tx2 }, { ...mint, txHash: tx2 }],
      at(30),
    );
    expect(inv(r, "unique-completion").result).toBe("FAIL");
    expect(r.reason).toBe("FAILED");
  });

  it("wrong domain: MessageReceived claiming another source domain fails domain-integrity", () => {
    const r = reduceLifecycle(
      ctx,
      withMint({}).map((e) => (e === received ? { ...received, sourceDomain: 3 } : e)),
      at(30),
    );
    expect(inv(r, "domain-integrity").result).toBe("FAIL");
  });

  it("wrong route: a trace configured for another destination fails domain-integrity", () => {
    const r = reduceLifecycle({ ...ctx, destinationDomain: 3 }, [burn, sent, attested], at(5));
    expect(inv(r, "domain-integrity")).toMatchObject({
      result: "FAIL",
      explanation: expect.stringContaining("6->26 != expected 6->3"),
    });
  });
});

describe("reduceLifecycle: data quality and reorgs", () => {
  const { ctx, burn, sent, attested, received, mint } = b2a;

  it("RPC inconsistency: conflicting content for one log makes integrity UNKNOWN, never FAILED", () => {
    const r = reduceLifecycle(ctx, [...b2a.all, { ...mint, amount: 1n }], at(30));
    expect(r.anomalies).toEqual([
      expect.stringContaining("conflicting observations for log 5042:"),
    ]);
    expect(r.reason).toBeNull();
    expect(inv(r, "value-conservation").result).toBe("UNKNOWN");
  });

  it("reorg replay: dropping the mint regresses to ATTESTED; re-inclusion elsewhere restores it", () => {
    expect(reduceLifecycle(ctx, [burn, sent, attested, received], at(5)).progress).toBe(
      "DESTINATION_SUBMITTED",
    );
    expect(reduceLifecycle(ctx, [burn, sent, attested], at(5)).progress).toBe("ATTESTED");
    const moved = [received, mint].map((e) => ({
      ...e,
      blockNumber: e.blockNumber + 3n,
      blockHash: `0x${"ab".repeat(32)}` as Hex,
    }));
    const r = reduceLifecycle(ctx, [burn, sent, attested, ...moved], at(30));
    expect(r).toMatchObject({ status: "MINT_CONFIRMED", anomalies: [] });
  });

  it("uses default deadlines when none are passed", () => {
    expect(DEFAULT_DEADLINES.finalityBySourceDomain[26]?.standard).toBe(10 * MIN);
  });
});
