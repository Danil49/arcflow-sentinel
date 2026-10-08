import type { AbiEvent, Address, Log, PublicClient } from "viem";

/** First block whose timestamp is >= `timestamp` (binary search; ~log2(head) RPC calls). */
export async function findBlockAtOrAfter(client: PublicClient, timestamp: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = await client.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < timestamp) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

export interface ChunkedLogQuery<E extends AbiEvent> {
  address: Address;
  event: E;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint;
  /** Max block span per eth_getLogs call; public RPCs cap this (Base public RPC: 500). */
  chunkSize: bigint;
  /** Stop at the first chunk that returns any log. */
  stopOnFirst?: boolean;
}

export async function getLogsChunked<E extends AbiEvent>(
  client: PublicClient,
  q: ChunkedLogQuery<E>,
): Promise<Log[]> {
  const out: Log[] = [];
  for (let from = q.fromBlock; from <= q.toBlock; from += q.chunkSize) {
    const to = from + q.chunkSize - 1n < q.toBlock ? from + q.chunkSize - 1n : q.toBlock;
    const logs = await client.getLogs({
      address: q.address,
      event: q.event,
      args: q.args,
      fromBlock: from,
      toBlock: to,
    } as Parameters<PublicClient["getLogs"]>[0]);
    out.push(...logs);
    if (q.stopOnFirst && out.length > 0) break;
  }
  return out;
}
