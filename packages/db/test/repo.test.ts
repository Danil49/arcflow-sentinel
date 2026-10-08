import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeCctpLogs,
  fromRpcLog,
  parseIrisMessages,
  type ChainEvent,
  type RpcLog,
} from "@sentinel/core";
import {
  commitRange,
  findTraceByNonce,
  findTracesBySourceTx,
  getCursor,
  getStoredBlockHash,
  getTraceEvents,
  insertAttestation,
  insertEvents,
  linkTxEvents,
  observedEvents,
  rewindStream,
  updateTrace,
  upsertTraceFromBurn,
} from "../src/index.js";
import { startTestDb, type TestDb } from "./postgres.js";

const dir = fileURLToPath(new URL("../../../fixtures/base-to-arc-complete/", import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(dir + f, "utf8"));
const TM = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;
const MT = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as const;
const decode = (file: string, chainId: number, domain: number): ChainEvent[] =>
  decodeCctpLogs(
    (load(file).logs as RpcLog[]).map((l) => fromRpcLog(l, chainId)),
    { domain, tokenMessenger: TM, messageTransmitter: MT },
  );
const sourceEvents = decode("source-receipt.json", 8453, 6);
const destEvents = decode("destination-receipt.json", 5042, 26);
const burn = sourceEvents.find((e) => e.kind === "burn")!;
const iris = load("iris-messages.json");

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

describe("traces", () => {
  it("upserting the same burn twice returns the same trace", async () => {
    const a = await upsertTraceFromBurn(t.db, burn, "SOURCE_OBSERVED");
    const b = await upsertTraceFromBurn(t.db, burn, "SOURCE_OBSERVED");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.trace.id).toBe(a.trace.id);
    expect(a.trace.amountAtomic).toBe(5_869_596n);
    expect(
      await findTracesBySourceTx(t.db, 8453, burn.txHash.toUpperCase().replace("0X", "0x")),
    ).toHaveLength(1);
  });

  it("enforces one trace per (source domain, nonce)", async () => {
    const { trace } = await upsertTraceFromBurn(t.db, burn, "SOURCE_OBSERVED");
    const nonce = "0x1F73AF1B2EE099C698D297119D9F995D70D1682F9247BC5BBB516F8114FE68B5";
    await updateTrace(t.db, trace.id, { messageNonce: nonce });
    expect((await findTraceByNonce(t.db, 6, nonce))?.id).toBe(trace.id);

    const other = await upsertTraceFromBurn(t.db, { ...burn, logIndex: 99 }, "SOURCE_OBSERVED");
    await expect(updateTrace(t.db, other.trace.id, { messageNonce: nonce })).rejects.toThrow();
  });
});

describe("observed events", () => {
  it("dedupes on (chainId, txHash, logIndex)", async () => {
    const { trace } = await upsertTraceFromBurn(t.db, burn, "SOURCE_OBSERVED");
    expect(await insertEvents(t.db, sourceEvents, trace.id)).toBe(2);
    expect(await insertEvents(t.db, sourceEvents, trace.id)).toBe(0);
    expect(await getTraceEvents(t.db, trace.id)).toHaveLength(2);
  });

  it("links uncorrelated destination events by tx", async () => {
    const { trace } = await upsertTraceFromBurn(t.db, burn, "SOURCE_OBSERVED");
    await insertEvents(t.db, destEvents, null);
    await linkTxEvents(t.db, trace.id, 5042, destEvents[0]!.txHash);
    const kinds = (await getTraceEvents(t.db, trace.id)).map((e) => e.eventType).sort();
    expect(kinds).toEqual(["message_received", "mint"]);
  });

  it("a reorg marks events removed and re-observation revives them", async () => {
    await insertEvents(t.db, destEvents, null);
    await commitRange(t.db, "arc:cctp", 5042, destEvents[0]!.blockNumber + 1n, []);
    await rewindStream(t.db, "arc:cctp", 5042, destEvents[0]!.blockNumber);
    let rows = await t.db.select().from(observedEvents);
    expect(rows.every((r) => r.removed)).toBe(true);
    expect(await getCursor(t.db, "arc:cctp")).toBe(destEvents[0]!.blockNumber);

    const moved = destEvents.map((e) => ({
      ...e,
      blockNumber: e.blockNumber + 1n,
      blockHash: `0x${"ab".repeat(32)}` as const,
    }));
    expect(await insertEvents(t.db, moved, null)).toBe(2);
    rows = await t.db.select().from(observedEvents);
    expect(rows.every((r) => !r.removed && r.blockNumber === destEvents[0]!.blockNumber + 1n)).toBe(
      true,
    );
  });
});

describe("cursors", () => {
  it("commits block hashes and prunes old ones", async () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({
      number: BigInt(i),
      hash: `0x${String(i).padStart(64, "0")}`,
    }));
    await commitRange(t.db, "s", 1, 10n, blocks, 5n);
    expect(await getCursor(t.db, "s")).toBe(10n);
    expect(await getStoredBlockHash(t.db, "s", 4n)).toBeNull();
    expect(await getStoredBlockHash(t.db, "s", 9n)).toBe(blocks[9]!.hash);
  });
});

describe("attestations", () => {
  it("stores identical Iris responses once", async () => {
    const { trace } = await upsertTraceFromBurn(t.db, burn, "SOURCE_OBSERVED");
    const [obs] = parseIrisMessages(iris, 6, burn.txHash, new Date());
    expect(await insertAttestation(t.db, trace.id, obs!, iris)).toBe(true);
    expect(await insertAttestation(t.db, trace.id, obs!, iris)).toBe(false);
  });
});
