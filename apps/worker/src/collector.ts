import type { Hex } from "viem";
import { decodeCctpLogs, type ChainEvent, type ObservedLog } from "@sentinel/core";
import {
  commitRange,
  enqueueJob,
  getCursor,
  getStoredBlockHash,
  insertEvents,
  rewindStream,
  type Db,
} from "@sentinel/db";
import type { RouteSide } from "./steps.js";

export const TRACE_CREATE = "trace.create";

export interface TraceCreatePayload {
  sourceDomain: number;
  sourceTxHash: Hex;
}

export interface CollectorOptions {
  db: Db;
  side: RouteSide;
  /** CCTP domain of the other chain on the route; only events for this route are stored. */
  peerDomain: number;
  /** Where to start when the stream has no cursor yet. */
  startBlock: bigint;
  /** Blocks to stay behind head (0 for Arc's deterministic finality). */
  confirmations: bigint;
  /**
   * Track block hashes and detect reorgs. Arc has deterministic finality, so it can skip this and
   * save two RPC calls per chunk.
   */
  checkReorgs: boolean;
  /** How far back to look for a fork point before giving up. */
  maxReorgDepth?: bigint;
}

export const streamName = (side: RouteSide) => `${side.config.key}:cctp`;

/** Keeps only events that belong to the Arc↔peer route, plus the logs that share their tx. */
export function routeRelevant(events: readonly ChainEvent[], peerDomain: number): ChainEvent[] {
  const txs = new Set<string>();
  for (const e of events) {
    if (
      (e.kind === "burn" && e.destinationDomain === peerDomain) ||
      (e.kind === "message_received" && e.sourceDomain === peerDomain)
    ) {
      txs.add(e.txHash.toLowerCase());
    }
  }
  return events.filter((e) => txs.has(e.txHash.toLowerCase()));
}

export type TickResult =
  | { kind: "idle"; head: bigint }
  | { kind: "processed"; fromBlock: bigint; toBlock: bigint; stored: number }
  | { kind: "reorg"; rewoundTo: bigint };

/**
 * Processes one chunk. The cursor, block hashes, events, and follow-up jobs for the chunk commit
 * in a single transaction, so a crash at any point re-reads the chunk on restart without
 * duplicating rows (inserts are idempotent) and without skipping any block.
 */
export async function collectorTick(opts: CollectorOptions): Promise<TickResult> {
  const { db, side } = opts;
  const stream = streamName(side);
  const chainId = side.config.chain.id;
  const cursor = (await getCursor(db, stream)) ?? opts.startBlock;

  const forkAt = opts.checkReorgs ? await findForkPoint(opts, stream, cursor) : null;
  if (forkAt !== null) {
    await db.transaction((tx) => rewindStream(tx, stream, chainId, forkAt));
    return { kind: "reorg", rewoundTo: forkAt };
  }

  const head = await side.client.getBlockNumber();
  const safeHead = head - opts.confirmations;
  if (cursor > safeHead) return { kind: "idle", head };
  const last = cursor + side.config.logChunkSize - 1n;
  const toBlock = last < safeHead ? last : safeHead;

  const logs = await side.client.getLogs({
    address: [side.config.tokenMessenger, side.config.messageTransmitter],
    fromBlock: cursor,
    toBlock,
  });
  const observed: ObservedLog[] = logs.map((l) => ({
    chainId,
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber!,
    blockHash: l.blockHash!,
    transactionHash: l.transactionHash!,
    logIndex: l.logIndex!,
  }));
  const events = routeRelevant(decodeCctpLogs(observed, side.config), opts.peerDomain);

  const blocks = new Map<bigint, string>();
  if (opts.checkReorgs) {
    blocks.set(toBlock, (await side.client.getBlock({ blockNumber: toBlock })).hash!);
    for (const e of events) blocks.set(e.blockNumber, e.blockHash);
  }

  const stored = await db.transaction(async (tx) => {
    const n = await insertEvents(tx, events, null);
    for (const burn of events.filter((e) => e.kind === "burn")) {
      const payload: TraceCreatePayload = {
        sourceDomain: side.config.domain,
        sourceTxHash: burn.txHash,
      };
      await enqueueJob(tx, TRACE_CREATE, payload, {
        dedupeKey: `${TRACE_CREATE}:${side.config.domain}:${burn.txHash.toLowerCase()}`,
      });
    }
    await commitRange(
      tx,
      stream,
      chainId,
      toBlock + 1n,
      [...blocks].map(([number, hash]) => ({ number, hash })),
    );
    return n;
  });
  return { kind: "processed", fromBlock: cursor, toBlock, stored };
}

/**
 * Compares the last processed block's stored hash with the chain. On mismatch, walks back to the
 * newest stored block that is still canonical and returns the block after it: hashes are only
 * stored for some blocks, so the fork can be anywhere after the last known-good one.
 */
async function findForkPoint(
  opts: CollectorOptions,
  stream: string,
  cursor: bigint,
): Promise<bigint | null> {
  const isCanonical = async (n: bigint) => {
    const stored = await getStoredBlockHash(opts.db, stream, n);
    if (stored === null) return null;
    const block = await opts.side.client.getBlock({ blockNumber: n });
    return block.hash!.toLowerCase() === stored;
  };
  if ((await isCanonical(cursor - 1n)) !== false) return null;

  const floor =
    cursor - (opts.maxReorgDepth ?? 128n) > 0n ? cursor - (opts.maxReorgDepth ?? 128n) : 0n;
  for (let n = cursor - 2n; n >= floor; n--) {
    // null = no stored hash for this block (no events, not a chunk end); keep walking back.
    if ((await isCanonical(n)) === true) return n + 1n;
  }
  return floor;
}
