import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { routeChains } from "@sentinel/chains";
import { chainCursors, getCursor, jobs, observedEvents } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { collectorTick, streamName, TRACE_CREATE, type CollectorOptions } from "../src/index.js";
import { defaultHash, destinationReceipt, fakeChain, logsAt, sourceReceipt } from "./fakes.js";

const chains = routeChains("mainnet");
const base = { ...chains.base, logChunkSize: 10n };
const arc = { ...chains.arc, logChunkSize: 10n };

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

function baseCollector(chain: ReturnType<typeof fakeChain>): CollectorOptions {
  return {
    db: t.db,
    side: { config: base, client: chain.client },
    peerDomain: 26,
    startBlock: 100n,
    confirmations: 0n,
    checkReorgs: true,
  };
}

async function drain(opts: CollectorOptions, max = 100) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = await collectorTick(opts);
    results.push(r);
    if (r.kind === "idle") return results;
  }
  throw new Error("collector did not reach head");
}

const allEvents = () => t.db.select().from(observedEvents);
const allJobs = () => t.db.select().from(jobs);

describe("collector", () => {
  it("stores only route events and enqueues one trace.create per burn", async () => {
    const chain = fakeChain({ head: 150n, logs: logsAt(sourceReceipt, 105n) });
    await drain(baseCollector(chain));
    const events = await allEvents();
    expect(events.map((e) => e.eventType).sort()).toEqual(["burn", "message_sent"]);
    const queued = await allJobs();
    expect(queued.map((j) => j.type)).toEqual([TRACE_CREATE]);
    expect(await getCursor(t.db, streamName(baseCollector(chain).side))).toBe(151n);
  });

  it("ignores burns to other domains", async () => {
    const chain = fakeChain({ head: 150n, logs: logsAt(sourceReceipt, 105n) });
    await drain({ ...baseCollector(chain), peerDomain: 3 });
    expect(await allEvents()).toHaveLength(0);
  });

  it("a crash mid-run then restart neither duplicates events nor loses the cursor", async () => {
    const logs = [
      ...logsAt(sourceReceipt, 105n),
      ...logsAt(sourceReceipt, 125n).map((l) => ({
        ...l,
        transactionHash: `0x${"cd".repeat(32)}` as Hex,
      })),
    ];
    const crashing = fakeChain({ head: 150n, logs, failGetLogsOnCall: 3 });
    await expect(drain(baseCollector(crashing))).rejects.toThrow("simulated RPC crash");
    const stream = streamName(baseCollector(crashing).side);
    expect(await getCursor(t.db, stream)).toBe(120n); // chunks 100-109, 110-119 committed

    const restarted = fakeChain({ head: 150n, logs });
    await drain(baseCollector(restarted));
    expect(restarted.state.getLogsCalls).toBe(4); // resumed at 120: 120-129 … 150
    expect(await getCursor(t.db, stream)).toBe(151n);
    expect(await allEvents()).toHaveLength(4);
    expect(await allJobs()).toHaveLength(2);

    // Even if the cursor is lost entirely, re-collecting the same blocks is idempotent.
    await t.db.delete(chainCursors);
    await drain(baseCollector(fakeChain({ head: 150n, logs })));
    expect(await allEvents()).toHaveLength(4);
    expect(await allJobs()).toHaveLength(2);
  });

  it("detects a reorg, marks orphaned events removed, and re-collects on the new fork", async () => {
    const logs = logsAt(sourceReceipt, 135n);
    await drain(baseCollector(fakeChain({ head: 150n, logs })));
    const stream = "base:cctp";
    expect((await allEvents()).every((e) => !e.removed)).toBe(true);

    const forked = (n: bigint): Hex =>
      n >= 130n ? `0x${"ee".repeat(28)}${n.toString(16).padStart(8, "0")}` : defaultHash(n);
    const chain = fakeChain({ head: 150n, logs, blockHash: forked });
    const first = await collectorTick(baseCollector(chain));
    expect(first).toEqual({ kind: "reorg", rewoundTo: 130n });
    expect((await allEvents()).every((e) => e.removed)).toBe(true);
    expect(await getCursor(t.db, stream)).toBe(130n);

    await drain(baseCollector(chain));
    const events = await allEvents();
    expect(events.every((e) => !e.removed && e.blockHash === forked(135n))).toBe(true);
    expect(await allJobs()).toHaveLength(1); // dedupe: still one live trace.create
  });

  it("tails Arc without reorg tracking and stores inbound MessageReceived + mint", async () => {
    const chain = fakeChain({ head: 120n, logs: logsAt(destinationReceipt, 110n) });
    await drain({
      db: t.db,
      side: { config: arc, client: chain.client },
      peerDomain: 6,
      startBlock: 100n,
      confirmations: 0n,
      checkReorgs: false,
    });
    expect((await allEvents()).map((e) => e.eventType).sort()).toEqual([
      "message_received",
      "mint",
    ]);
    expect(await allJobs()).toHaveLength(0);
  });
});
