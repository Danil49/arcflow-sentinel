import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { routeChains } from "@sentinel/chains";
import { getTrace, getTraceEvents, insertEvents, jobs } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { decodeCctpLogs, fromRpcLog } from "@sentinel/core";
import { createTraces, refreshTrace, TraceInputError, type PipelineDeps } from "../src/index.js";
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

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

function deps(irisClient = staticIris(iris), opts: { minted?: boolean } = {}): PipelineDeps {
  const minted = opts.minted ?? true;
  return {
    db: t.db,
    source: {
      config: chains.base,
      client: fakeChain({ head: 2_000n, receipts: { [SRC]: receiptAt(sourceReceipt, SRC_BLOCK) } })
        .client,
    },
    destination: {
      config: chains.arc,
      client: fakeChain({
        head: 2_000n,
        receipts: minted ? { [DST]: receiptAt(destinationReceipt, DST_BLOCK) } : {},
        logs: minted ? logsAt(destinationReceipt, DST_BLOCK) : [],
      }).client,
    },
    iris: irisClient,
    pollMs: { attestation: 1_000, destination: 500 },
  };
}

describe("createTraces", () => {
  it("is idempotent and schedules exactly one refresh job", async () => {
    const d = deps();
    const [a] = await createTraces(d, SRC);
    const [b] = await createTraces(d, SRC);
    expect(b!.id).toBe(a!.id);
    expect(await getTraceEvents(t.db, a!.id)).toHaveLength(2);
    const queued = await t.db.select().from(jobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ traceId: a!.id, sourceDomain: 6 });
  });

  it("rejects unknown txs and burns off the configured route", async () => {
    await expect(createTraces(deps(), `0x${"00".repeat(32)}`)).rejects.toThrow(TraceInputError);
    const wrongRoute = {
      ...deps(),
      destination: { ...deps().destination, config: { ...chains.arc, domain: 3 } },
    };
    await expect(createTraces(wrongRoute, SRC)).rejects.toThrow(/expected 3/);
  });
});

describe("refreshTrace", () => {
  it("walks SOURCE_OBSERVED → FINALITY_WAIT → ATTESTED → MINT_CONFIRMED across polls", async () => {
    const pending = {
      messages: [{ status: "pending_confirmations", attestation: "PENDING", message: "0x" }],
    };
    const d = deps(staticIris(null, pending, iris));
    const [trace] = await createTraces(d, SRC);
    const payload = { traceId: trace!.id, sourceDomain: 6 };

    let r = await refreshTrace(d, payload);
    expect(r).toMatchObject({ kind: "wait", status: "SOURCE_OBSERVED", delayMs: 1_000 });
    r = await refreshTrace(d, payload);
    expect(r).toMatchObject({ kind: "wait", status: "FINALITY_WAIT" });
    r = await refreshTrace(d, payload);
    expect(r).toMatchObject({ kind: "done", status: "MINT_CONFIRMED" });

    const stored = await getTrace(t.db, trace!.id);
    expect(stored).toMatchObject({
      status: "MINT_CONFIRMED",
      messageNonce: expect.stringMatching(/^0x1f73/),
    });
    const kinds = (await getTraceEvents(t.db, trace!.id)).map((e) => e.eventType).sort();
    expect(kinds).toEqual(["burn", "message_received", "message_sent", "mint"]);
  });

  it("remembers how far the destination was searched while waiting for the mint", async () => {
    const d = deps(staticIris(iris), { minted: false });
    const [trace] = await createTraces(d, SRC);
    const r = await refreshTrace(d, { traceId: trace!.id, sourceDomain: 6 });
    expect(r).toMatchObject({
      kind: "wait",
      status: "ATTESTED",
      payload: { destinationFromBlock: "2001" },
    });
  });

  it("uses a MessageReceived the collector already stored", async () => {
    const d = deps(staticIris(iris), { minted: false });
    const [trace] = await createTraces(d, SRC);
    const destEvents = decodeCctpLogs(
      logsAt(destinationReceipt, DST_BLOCK).map((l) => fromRpcLog(l, 5042)),
      chains.arc,
    );
    await insertEvents(t.db, destEvents, null);
    const r = await refreshTrace(d, { traceId: trace!.id, sourceDomain: 6 });
    expect(r).toMatchObject({ kind: "done", status: "MINT_CONFIRMED" });
  });

  it("never moves status backwards on a stale observation", async () => {
    const d = deps();
    const [trace] = await createTraces(d, SRC);
    await refreshTrace(d, { traceId: trace!.id, sourceDomain: 6 });
    const again = await refreshTrace(
      { ...d, iris: staticIris(null) },
      { traceId: trace!.id, sourceDomain: 6 },
    );
    expect(again.status).toBe("MINT_CONFIRMED");
  });
});
