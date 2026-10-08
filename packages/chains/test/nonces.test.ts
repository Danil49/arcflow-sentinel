import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { findNonceUsedBlock } from "../src/index.js";

const NONCE = `0x${"11".repeat(32)}` as const;
const TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

function client(usedAt: bigint | null) {
  const calls: bigint[] = [];
  const c = {
    readContract: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.push(blockNumber);
      return usedAt !== null && blockNumber >= usedAt ? 1n : 0n;
    },
  } as unknown as PublicClient;
  return { c, calls };
}

describe("findNonceUsedBlock", () => {
  it("finds the exact consuming block in ~log2(range) calls", async () => {
    const { c, calls } = client(24_791_398n);
    expect(await findNonceUsedBlock(c, TRANSMITTER, NONCE, 24_000_000n, 25_000_000n)).toBe(
      24_791_398n,
    );
    expect(calls.length).toBeLessThanOrEqual(22);
  });

  it("returns null when the nonce is unused at the upper bound", async () => {
    const { c, calls } = client(null);
    expect(await findNonceUsedBlock(c, TRANSMITTER, NONCE, 0n, 1_000n)).toBeNull();
    expect(calls).toEqual([1_000n]);
  });

  it("handles a nonce used at the lower bound", async () => {
    const { c } = client(5n);
    expect(await findNonceUsedBlock(c, TRANSMITTER, NONCE, 5n, 100n)).toBe(5n);
  });
});
