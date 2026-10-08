import type { Address, Hex, PublicClient } from "viem";
import { messageTransmitterV2ReadAbi } from "@sentinel/core";

const isUsedAt = async (client: PublicClient, transmitter: Address, nonce: Hex, block: bigint) =>
  (await client.readContract({
    address: transmitter,
    abi: messageTransmitterV2ReadAbi,
    functionName: "usedNonces",
    args: [nonce],
    blockNumber: block,
  })) !== 0n;

/**
 * Finds the destination block whose transaction consumed `nonce`, by binary-searching
 * `usedNonces` with historical eth_call (~log2(range) calls, needs archive state). This replaces
 * wide eth_getLogs scans, which many RPC tiers cap at a handful of blocks. Returns null if the
 * nonce is still unused at `toBlock`.
 */
export async function findNonceUsedBlock(
  client: PublicClient,
  transmitter: Address,
  nonce: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<bigint | null> {
  if (!(await isUsedAt(client, transmitter, nonce, toBlock))) return null;
  let lo = fromBlock;
  let hi = toBlock;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await isUsedAt(client, transmitter, nonce, mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}
