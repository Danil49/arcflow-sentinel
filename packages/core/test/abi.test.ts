import { toEventSelector } from "viem";
import { describe, expect, it } from "vitest";
import { cctpV2EventsAbi } from "../src/index.js";
import { baseToArc } from "./fixtures.js";

describe("CCTP V2 ABI", () => {
  it("matches topic0 of every CCTP event in the captured real receipts", () => {
    const selectors = new Map(cctpV2EventsAbi.map((e) => [toEventSelector(e), e.name]));
    const seen = [...baseToArc.sourceReceipt.logs, ...baseToArc.destinationReceipt.logs]
      .map((l) => selectors.get(l.topics[0]!))
      .filter(Boolean);
    expect(new Set(seen)).toEqual(
      new Set(["DepositForBurn", "MessageSent", "MintAndWithdraw", "MessageReceived"]),
    );
  });
});
