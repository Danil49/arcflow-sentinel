import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseGwei,
  parseTransaction,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { routeChains } from "@sentinel/chains";
import { evidenceRegistryAbi, traceIdToBytes32 } from "@sentinel/contracts";
import { evidenceBundles } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { signerFromSeed } from "@sentinel/evidence";
import {
  AnchorPolicyError,
  anchorTrace,
  createTraces,
  refreshTrace,
  type Anchorer,
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

const REGISTRY = "0xD37a99DC7a7CA2E3b1A75648886875E50a6b52FF" as const;
const account = privateKeyToAccount(`0x${"ab".repeat(32)}`);
const signer = signerFromSeed("33".repeat(32));
const chains = routeChains("mainnet");
const USDC = 10n ** 18n;

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

interface ChainOpts {
  balance?: bigint;
  baseFee?: bigint;
  failSends?: number;
  revert?: boolean;
  /** Receipt never appears; the account nonce moves on (someone else used it). */
  replaced?: boolean;
}

/** Fake Arc: records broadcasts and mines each distinct tx once, emitting the real event. */
function fakeArc(o: ChainOpts = {}) {
  const sent: Hex[] = [];
  const mined = new Map<Hex, { raw: Hex; block: bigint }>();
  let failSends = o.failSends ?? 0;
  let confirmedNonce = 0;
  const client = {
    chain: arcTestnet,
    getBalance: async () => o.balance ?? 20n * USDC,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: (o.baseFee ?? parseGwei("20")) * 2n,
      maxPriorityFeePerGas: parseGwei("1"),
    }),
    // replaced: we sign with pending nonce 0, but another tx already confirmed nonce 0.
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      o.replaced
        ? blockTag === "pending"
          ? 0
          : 1
        : blockTag === "pending"
          ? mined.size
          : confirmedNonce,
    estimateGas: async () => 30_000n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      sent.push(serializedTransaction);
      if (failSends-- > 0) throw new Error("fetch failed: socket hang up");
      const hash = keccak256(serializedTransaction);
      if (!o.replaced && !mined.has(hash)) {
        mined.set(hash, { raw: serializedTransaction, block: 100n + BigInt(mined.size) });
        confirmedNonce++;
      }
      return hash;
    },
    getTransaction: async () => null,
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const m = mined.get(hash);
      if (!m) throw new Error("WaitForTransactionReceiptTimeoutError");
      const tx = parseTransaction(m.raw);
      const [traceId, evidenceHash, status, observedAt] = decodeAnchorArgs(tx.data!);
      return {
        status: o.revert ? "reverted" : "success",
        blockNumber: m.block,
        gasUsed: 25_000n,
        effectiveGasPrice: parseGwei("21"),
        logs: o.revert
          ? []
          : [
              {
                address: REGISTRY,
                topics: encodeEventTopics({
                  abi: evidenceRegistryAbi,
                  eventName: "EvidenceAnchored",
                  args: { traceId, evidenceHash, submitter: account.address },
                }),
                data: encodeAbiParameters(
                  [{ type: "uint8" }, { type: "uint64" }],
                  [status, observedAt],
                ),
              },
            ],
      };
    },
  } as unknown as PublicClient;
  return { client, sent, mined };
}

function decodeAnchorArgs(data: Hex): [Hex, Hex, number, bigint] {
  const body = data.slice(10);
  const word = (i: number) => `0x${body.slice(i * 64, (i + 1) * 64)}` as Hex;
  return [word(0), word(1), Number(BigInt(word(2))), BigInt(word(3))];
}

function anchorer(client: PublicClient, over: Partial<Anchorer> = {}): Anchorer {
  return {
    network: "testnet",
    chainId: arcTestnet.id,
    registry: REGISTRY,
    account,
    client,
    // A real local-account wallet: signing happens offline, so this exercises real tx encoding.
    wallet: {
      signTransaction: (tx: Parameters<typeof account.signTransaction>[0]) =>
        account.signTransaction({ ...tx, chainId: arcTestnet.id }),
    } as never,
    maxFeeWei: USDC / 20n, // 0.05 USDC
    minBalanceWei: USDC / 2n, // 0.5 USDC
    explorerTxUrl: (h) => h,
    ...over,
  };
}

async function completedTrace(): Promise<string> {
  const d: PipelineDeps = {
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
  };
  const id = (await createTraces(d, SRC)).traces[0]!.id;
  await refreshTrace(d, { traceId: id, sourceDomain: 6 });
  return id;
}

const bundles = () => t.db.select().from(evidenceBundles);

describe("anchorTrace", () => {
  it("anchors the evidence hash once, with the right call data, and records cost", async () => {
    const id = await completedTrace();
    const arc = fakeArc();
    const r = await anchorTrace(t.db, anchorer(arc.client), id, signer, "mainnet");
    expect(r).toMatchObject({ kind: "confirmed", alreadyAnchored: false });
    const [row] = await bundles();
    expect(row).toMatchObject({
      anchorStatus: "confirmed",
      anchorNetwork: "testnet",
      anchorChainId: arcTestnet.id,
      anchorRegistry: REGISTRY.toLowerCase(),
      anchorSubmitter: account.address.toLowerCase(),
      anchorBlockNumber: 100n,
      anchorCostWei: 25_000n * parseGwei("21"),
      anchorRawTx: null,
    });
    const [traceId, evidenceHash, status] = decodeAnchorArgs(parseTransaction(arc.sent[0]!).data!);
    expect(traceId).toBe(traceIdToBytes32(id));
    expect(evidenceHash).toBe(row!.keccak256);
    expect(status).toBe(6); // MINT_CONFIRMED
    const tx = parseTransaction(arc.sent[0]!);
    expect(tx.to?.toLowerCase()).toBe(REGISTRY.toLowerCase());
    expect(tx.maxFeePerGas! >= parseGwei("20")).toBe(true); // Arc floor

    const again = await anchorTrace(t.db, anchorer(arc.client), id, signer, "mainnet");
    expect(again).toMatchObject({ kind: "confirmed", alreadyAnchored: true });
    expect(arc.sent).toHaveLength(1);
  });

  it("a crash during broadcast resumes with the identical signed tx (no second anchor)", async () => {
    const id = await completedTrace();
    const arc = fakeArc({ failSends: 1 });
    await expect(anchorTrace(t.db, anchorer(arc.client), id, signer, "mainnet")).rejects.toThrow(
      /socket hang up/,
    );
    expect((await bundles())[0]).toMatchObject({ anchorStatus: "submitted" });

    const r = await anchorTrace(t.db, anchorer(arc.client), id, signer, "mainnet");
    expect(r?.kind).toBe("confirmed");
    expect(arc.sent).toHaveLength(2);
    expect(arc.sent[1]).toBe(arc.sent[0]); // same nonce, same hash
    expect(arc.mined.size).toBe(1);
  });

  it("concurrent anchors of the same trace sign and send exactly one tx", async () => {
    const id = await completedTrace();
    const arc = fakeArc();
    const a = anchorer(arc.client);
    const results = await Promise.all(
      [1, 2, 3].map(() => anchorTrace(t.db, a, id, signer, "mainnet")),
    );
    expect(results.every((r) => r?.kind === "confirmed")).toBe(true);
    expect(new Set(arc.sent).size).toBe(1);
  });

  it("refuses when the worst-case fee exceeds the cap or the balance is too low", async () => {
    const id = await completedTrace();
    const pricey = fakeArc({ baseFee: parseGwei("20000") }); // Arc's base-fee ceiling
    await expect(anchorTrace(t.db, anchorer(pricey.client), id, signer, "mainnet")).rejects.toThrow(
      AnchorPolicyError,
    );
    const poor = fakeArc({ balance: USDC / 2n });
    await expect(anchorTrace(t.db, anchorer(poor.client), id, signer, "mainnet")).rejects.toThrow(
      /ANCHOR_MIN_BALANCE_USDC/,
    );
    expect(pricey.sent.length + poor.sent.length).toBe(0);
    expect((await bundles())[0]!.anchorStatus).toBeNull();
  });

  it("a reverted anchor is marked failed and a later attempt re-signs", async () => {
    const id = await completedTrace();
    const reverting = fakeArc({ revert: true });
    expect(
      await anchorTrace(t.db, anchorer(reverting.client), id, signer, "mainnet"),
    ).toMatchObject({ kind: "failed" });
    expect((await bundles())[0]).toMatchObject({
      anchorStatus: "failed",
      anchorError: expect.stringContaining("reverted"),
    });
    const ok = fakeArc();
    expect((await anchorTrace(t.db, anchorer(ok.client), id, signer, "mainnet"))?.kind).toBe(
      "confirmed",
    );
  });

  it("detects a nonce taken by another transaction and fails instead of waiting forever", async () => {
    const id = await completedTrace();
    const arc = fakeArc({ replaced: true });
    const r = await anchorTrace(t.db, anchorer(arc.client), id, signer, "mainnet");
    expect(r).toMatchObject({ kind: "failed", error: expect.stringContaining("replaced") });
  });

  it("returns null for unknown traces", async () => {
    expect(
      await anchorTrace(
        t.db,
        anchorer(fakeArc().client),
        "00000000-0000-0000-0000-000000000000",
        signer,
        "mainnet",
      ),
    ).toBeNull();
  });
});
