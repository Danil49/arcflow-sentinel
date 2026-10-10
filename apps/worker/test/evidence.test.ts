import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { routeChains } from "@sentinel/chains";
import { evidenceBundles, observedEvents } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { signerFromSeed, verifyEvidence } from "@sentinel/evidence";
import { createTraces, refreshTrace, sealTraceEvidence, type PipelineDeps } from "../src/index.js";
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

const signer = signerFromSeed("11".repeat(32));
const chains = routeChains("mainnet");
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

const deps = (): PipelineDeps => ({
  db: t.db,
  now: () => new Date(1_000_000 + 5 * 60_000),
  iris: staticIris(iris),
  source: {
    config: chains.base,
    client: fakeChain({ head: 2_000n, receipts: { [SRC]: receiptAt(sourceReceipt, 1_000n) } })
      .client,
  },
  destination: {
    config: chains.arc,
    client: fakeChain({
      head: 2_000n,
      receipts: { [DST]: receiptAt(destinationReceipt, 1_050n) },
      logs: logsAt(destinationReceipt, 1_050n),
    }).client,
  },
});

async function completedTrace() {
  const d = deps();
  const id = (await createTraces(d, SRC)).traces[0]!.id;
  await refreshTrace(d, { traceId: id, sourceDomain: 6 });
  return id;
}

describe("sealTraceEvidence", () => {
  it("seals a verifiable bundle of the stored evidence and verdict", async () => {
    const id = await completedTrace();
    const sealed = (await sealTraceEvidence(t.db, id, signer, "mainnet"))!;
    const { payload } = sealed.bundle;
    expect(payload.verdict.status).toBe("MINT_CONFIRMED");
    expect(payload.trace).toMatchObject({
      amountAtomic: "5869596",
      destinationTxHash: DST.toLowerCase(),
    });
    // Canonical order: chainId, block, logIndex (Arc 5042 sorts before Base 8453).
    expect(payload.observations.chainEvents.map((e) => e.eventType)).toEqual([
      "mint",
      "message_received",
      "message_sent",
      "burn",
    ]);
    expect(payload.invariants.map((i) => i.result)).toEqual([
      "PASS",
      "PASS",
      "PASS",
      "PASS",
      "PASS",
    ]);
    expect(verifyEvidence(sealed.bundle, signer.publicKeyHex).ok).toBe(true);
    expect(sealed.row).toMatchObject({
      traceId: id,
      keccak256: sealed.bundle.hashes.keccak256,
      status: "MINT_CONFIRMED",
    });
  });

  it("unchanged evidence yields the same stored bundle; a change yields a new one", async () => {
    const id = await completedTrace();
    const a = (await sealTraceEvidence(t.db, id, signer, "mainnet"))!;
    await refreshTrace(deps(), { traceId: id, sourceDomain: 6 }); // re-evaluates; nothing new
    const b = (await sealTraceEvidence(t.db, id, signer, "mainnet"))!;
    expect(b.row.id).toBe(a.row.id);
    expect(b.bundle.hashes).toEqual(a.bundle.hashes);

    await t.db.update(observedEvents).set({ removed: true }); // a reorg is recorded
    const c = (await sealTraceEvidence(t.db, id, signer, "mainnet"))!;
    expect(c.bundle.hashes.keccak256).not.toBe(a.bundle.hashes.keccak256);
    expect(await t.db.select().from(evidenceBundles)).toHaveLength(2);
  });

  it("returns null for an unknown trace", async () => {
    expect(
      await sealTraceEvidence(t.db, "00000000-0000-0000-0000-000000000000", signer, "mainnet"),
    ).toBeNull();
  });
});
