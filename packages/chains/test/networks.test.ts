import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { chainByDomain, routeChains } from "../src/index.js";

describe("routeChains", () => {
  it.each(["mainnet", "testnet"] as const)("%s addresses are valid checksummed addresses", (n) => {
    for (const c of Object.values(routeChains(n))) {
      for (const a of [c.tokenMessenger, c.messageTransmitter, c.usdc])
        expect(getAddress(a)).toBe(a);
    }
  });

  it("maps domains to chains", () => {
    expect(chainByDomain("mainnet", 26)?.chain.id).toBe(5042);
    expect(chainByDomain("mainnet", 6)?.chain.id).toBe(8453);
    expect(chainByDomain("mainnet", 0)).toBeUndefined();
  });
});
