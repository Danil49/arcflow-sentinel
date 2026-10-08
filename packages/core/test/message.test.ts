import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import {
  bytes32ToAddress,
  decodeBurnMessageV2,
  decodeMessageHeaderV2,
  MessageDecodeError,
  ZERO_BYTES32,
} from "../src/index.js";
import { baseToArc } from "./fixtures.js";

const attestedMessage = baseToArc.iris.messages![0]!.message as Hex;

describe("decodeBurnMessageV2", () => {
  it("decodes the attested Base→Arc message", () => {
    const m = decodeBurnMessageV2(attestedMessage);
    expect(m).toMatchObject({
      version: 1,
      sourceDomain: 6,
      destinationDomain: 26,
      nonce: "0x1f73af1b2ee099c698d297119d9f995d70d1682f9247bc5bbb516f8114fe68b5",
      destinationCaller: ZERO_BYTES32,
      minFinalityThreshold: 2000,
      finalityThresholdExecuted: 2000,
    });
    expect(bytes32ToAddress(m.sender)).toBe(
      getAddress("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"),
    );
    expect(bytes32ToAddress(m.body.burnToken)).toBe(
      getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
    );
    expect(bytes32ToAddress(m.body.mintRecipient)).toBe(
      getAddress("0x299229222148e00cee5676446eed9bab5231d062"),
    );
    expect(m.body.amount).toBe(5_869_596n);
    expect(m.body.maxFee).toBe(0n);
    expect(m.body.feeExecuted).toBe(0n);
    expect(m.body.hookData).toBe("0x");
  });

  it("rejects truncated messages", () => {
    expect(() => decodeMessageHeaderV2("0x0000")).toThrow(MessageDecodeError);
    const headerOnly = attestedMessage.slice(0, 2 + 148 * 2) as Hex;
    expect(() => decodeBurnMessageV2(headerOnly)).toThrow(MessageDecodeError);
  });
});

describe("bytes32ToAddress", () => {
  it("rejects non-EVM (not left-padded) values", () => {
    expect(() => bytes32ToAddress(`0x${"ff".repeat(32)}`)).toThrow(MessageDecodeError);
  });
});
