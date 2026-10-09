import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { Hex } from "viem";
import { routeChains } from "@sentinel/chains";
import { decodeCctpLogs, fromRpcLog } from "@sentinel/core";
import {
  getInvariantResults,
  getTrace,
  getTraceEvents,
  insertEvents,
  jobs,
  webhookDeliveries,
} from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import {
  confirmTrace,
  createTraces,
  refreshTrace,
  resolveDeadlines,
  TraceInputError,
  WEBHOOK_DELIVER,
  type PipelineDeps,
} from "../src/index.js";
import {
  DST,
  destinationReceipt,
  fakeChain,
  iris,
  logsAt,
  receiptAt,
  SRC,
  sourceReceipt,
  staticIris,
} from "./fakes.js";

const chains = routeChains("mainnet");
const SRC_BLOCK = 1_000n;
const DST_BLOCK = 1_050n;
// Fake chains use timestamp == block number (seconds), so the burn happened at t=1000s.
const BURN_TIME = 1_000_000;
const MIN = 60_000;
const pending = {
  messages: [{ status: "pending_confirmations", attestation: "PENDING", message: "0x" }],
};

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

interface DepsOpts {
  minted?: boolean;
  minutesAfterBurn?: number;
  destinationReceipt?: typeof destinationReceipt;
  webhooks?: boolean;
}

function deps(
  irisClient = staticIris(iris),
  o: DepsOpts = {},
): PipelineDeps & { clock: { minutes: number } } {
  const minted = o.minted ?? true;
  const dst = o.destinationReceipt ?? destinationReceipt;
  const clock = { minutes: o.minutesAfterBurn ?? 5 };
  return {
    clock,
    db: t.db,
    now: () => new Date(BURN_TIME + clock.minutes * MIN),
    source: {
      config: chains.base,
      client: fakeChain({ head: 2_000n, receipts: { [SRC]: receiptAt(sourceReceipt, SRC_BLOCK) } })
        .client,
    },
    destination: {
      config: chains.arc,
      client: fakeChain({
        head: 2_000n,
        receipts: minted ? { [DST]: receiptAt(dst, DST_BLOCK) } : {},
        logs: minted ? logsAt(dst, DST_BLOCK) : [],
      }).client,
    },
    iris: irisClient,
    pollMs: { attestation: 1_000, destination: 500, slow: 9_000 },
    webhooks: o.webhooks
      ? {
          urls: ["https://hooks.example.com/a", "https://hooks.example.com/b"],
          secret: "s".repeat(32),
          timeoutMs: 1_000,
        }
      : null,
  };
}

const refresh = (d: PipelineDeps, traceId: string, extra = {}) =>
  refreshTrace(d, { traceId, sourceDomain: 6, ...extra });

describe("createTraces", () => {
  it("is idempotent, stores the burn time, and schedules exactly one refresh job", async () => {
    const d = deps();
    const a = await createTraces(d, SRC);
    const b = await createTraces(d, SRC);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.traces[0]!.id).toBe(a.traces[0]!.id);
    expect(a.traces[0]!.sourceBlockTime).toEqual(new Date(BURN_TIME));
    expect(await getTraceEvents(t.db, a.traces[0]!.id)).toHaveLength(2);
    expect(await t.db.select().from(jobs)).toHaveLength(1);
  });

  it("requiring application confirmation is opt-in and can be added later, not removed", async () => {
    const d = deps();
    const { traces } = await createTraces(d, SRC);
    expect(traces[0]!.requireAppConfirmation).toBe(false);
    const again = await createTraces(d, SRC, { requireAppConfirmation: true });
    expect(again.traces[0]!.requireAppConfirmation).toBe(true);
    const third = await createTraces(d, SRC);
    expect(third.traces[0]!.requireAppConfirmation).toBe(true);
  });

  it("rejects unknown txs and burns off the configured route", async () => {
    await expect(createTraces(deps(), `0x${"00".repeat(32)}`)).rejects.toThrow(TraceInputError);
    const d = deps();
    const wrongRoute = {
      ...d,
      destination: { ...d.destination, config: { ...chains.arc, domain: 3 } },
    };
    await expect(createTraces(wrongRoute, SRC)).rejects.toThrow(/expected 3/);
  });
});

describe("refreshTrace", () => {
  it("walks SOURCE_OBSERVED → FINALITY_WAIT → MINT_CONFIRMED and persists invariants", async () => {
    const d = deps(staticIris(null, pending, iris));
    const id = (await createTraces(d, SRC)).traces[0]!.id;

    expect(await refresh(d, id)).toMatchObject({
      kind: "wait",
      status: "SOURCE_OBSERVED",
      delayMs: 1_000,
    });
    expect(await refresh(d, id)).toMatchObject({
      kind: "wait",
      status: "FINALITY_WAIT",
      delayMs: 1_000,
    });
    expect(await refresh(d, id)).toMatchObject({ kind: "done", status: "MINT_CONFIRMED" });

    const trace = await getTrace(t.db, id);
    expect(trace).toMatchObject({
      status: "MINT_CONFIRMED",
      progress: "MINT_CONFIRMED",
      reason: null,
      messageNonce: expect.stringMatching(/^0x1f73/),
      destinationTxHash: DST.toLowerCase(),
    });
    const invariants = await getInvariantResults(t.db, id);
    expect(invariants.map((i) => [i.ruleId, i.result])).toEqual([
      ["domain-integrity", "PASS"],
      ["progress-bound", "PASS"],
      ["recipient-integrity", "PASS"],
      ["unique-completion", "PASS"],
      ["value-conservation", "PASS"],
    ]);
  });

  it("remembers how far the destination was searched while waiting for the mint", async () => {
    const d = deps(staticIris(iris), { minted: false });
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    expect(await refresh(d, id)).toMatchObject({
      kind: "wait",
      status: "ATTESTED",
      delayMs: 500,
      payload: { destinationFromBlock: "2001" },
    });
  });

  it("uses a MessageReceived the collector already stored", async () => {
    const d = deps(staticIris(iris), { minted: false });
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    const destEvents = decodeCctpLogs(
      logsAt(destinationReceipt, DST_BLOCK).map((l) => fromRpcLog(l, 5042)),
      chains.arc,
    );
    await insertEvents(t.db, destEvents, null);
    expect(await refresh(d, id)).toMatchObject({ kind: "done", status: "MINT_CONFIRMED" });
  });

  it("flags STUCK past the deadline, polls slowly, and recovers when evidence arrives", async () => {
    const d = deps(staticIris(null, null, iris), { minutesAfterBurn: 11 });
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    expect(await refresh(d, id)).toMatchObject({
      kind: "wait",
      status: "FAILED_OR_STUCK",
      delayMs: 9_000,
    });
    expect(await getTrace(t.db, id)).toMatchObject({
      reason: "STUCK",
      progress: "SOURCE_OBSERVED",
    });

    await refresh(d, id); // Iris still silent
    expect(await refresh(d, id)).toMatchObject({ kind: "done", status: "MINT_CONFIRMED" });
    expect((await getTrace(t.db, id))!.reason).toBeNull();
  });

  it("stops polling after the max tracking age, leaving the trace STUCK", async () => {
    const d = { ...deps(staticIris(null), { minutesAfterBurn: 60 }), maxTrackingMs: 30 * MIN };
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    expect(await refresh(d, id)).toEqual({ kind: "done", status: "FAILED_OR_STUCK" });
  });

  it("a mint to the wrong recipient is FAILED (terminal) by recipient-integrity", async () => {
    const tampered = structuredClone(destinationReceipt);
    const mintLog = tampered.logs.find((l: { topics: Hex[] }) =>
      l.topics[0]!.startsWith("0x50c55e91"),
    );
    mintLog.topics[1] = `0x${"00".repeat(12)}${"be".repeat(20)}`;
    const d = deps(staticIris(iris), { destinationReceipt: tampered });
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    expect(await refresh(d, id)).toEqual({ kind: "done", status: "FAILED_OR_STUCK" });
    const trace = await getTrace(t.db, id);
    expect(trace).toMatchObject({
      reason: "FAILED",
      statusReason: expect.stringMatching(/^recipient-integrity/),
    });
  });
});

describe("application confirmation", () => {
  it("MINT_CONFIRMED waits for the application; confirming completes the trace", async () => {
    const d = deps(staticIris(iris));
    const id = (await createTraces(d, SRC, { requireAppConfirmation: true })).traces[0]!.id;
    expect(await refresh(d, id)).toMatchObject({
      kind: "wait",
      status: "MINT_CONFIRMED",
      delayMs: 9_000,
    });

    const result = await confirmTrace(d, id, "order-42");
    expect(result).toMatchObject({ status: "APPLICATION_CONFIRMED", terminal: true });
    expect(await getTrace(t.db, id)).toMatchObject({
      applicationReference: "order-42",
      status: "APPLICATION_CONFIRMED",
    });

    // Idempotent: a second confirmation keeps the first reference.
    await confirmTrace(d, id, "other");
    expect((await getTrace(t.db, id))!.applicationReference).toBe("order-42");
    expect(await refresh(d, id)).toEqual({ kind: "done", status: "APPLICATION_CONFIRMED" });
  });

  it("returns null for unknown traces", async () => {
    expect(await confirmTrace(deps(), "00000000-0000-0000-0000-000000000000", null)).toBeNull();
  });
});

describe("webhook outbox", () => {
  it("writes one delivery per endpoint per status change, with a monotonic sequence", async () => {
    const d = deps(staticIris(null, pending, iris), { webhooks: true });
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    await refresh(d, id); // SOURCE_OBSERVED -> SOURCE_OBSERVED: no change
    await refresh(d, id); // -> FINALITY_WAIT
    await refresh(d, id); // -> ATTESTED -> MINT_CONFIRMED

    const rows = await t.db.select().from(webhookDeliveries).orderBy(asc(webhookDeliveries.id));
    const perUrl = rows.filter((r) => r.url.endsWith("/a"));
    expect(
      perUrl.map((r) => [r.sequence, (r.payload as { data: { status: string } }).data.status]),
    ).toEqual([
      [1, "FINALITY_WAIT"],
      [2, "ATTESTED"],
      [3, "MINT_CONFIRMED"],
    ]);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(3);
    const deliverJobs = (await t.db.select().from(jobs)).filter((j) => j.type === WEBHOOK_DELIVER);
    expect(deliverJobs).toHaveLength(6);
  });

  it("no endpoints configured: no deliveries", async () => {
    const d = deps(staticIris(iris));
    const id = (await createTraces(d, SRC)).traces[0]!.id;
    await refresh(d, id);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(0);
  });
});

describe("resolveDeadlines", () => {
  it("applies minute overrides on top of defaults", () => {
    const r = resolveDeadlines({ mint: 180, finality: { standard: 60 } });
    expect(r.mint).toBe(180 * MIN);
    expect(r.finality).toEqual({ standard: 60 * MIN, fast: 10 * MIN });
    expect(r.finalityBySourceDomain).toEqual({});
    expect(resolveDeadlines(undefined).finalityBySourceDomain[26]).toBeDefined();
  });
});
