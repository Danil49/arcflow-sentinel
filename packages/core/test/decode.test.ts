import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeCctpLogs,
  fromRpcLog,
  parseIrisMessages,
  ZERO_BYTES32,
  type ChainEvent,
} from "../src/index.js";
import { ARC, BASE, baseToArc, MESSAGE_TRANSMITTER, TOKEN_MESSENGER } from "./fixtures.js";

const contracts = (domain: number) =>
  ({
    domain,
    tokenMessenger: TOKEN_MESSENGER,
    messageTransmitter: MESSAGE_TRANSMITTER,
  }) as const;

const decode = (logs: typeof baseToArc.sourceReceipt.logs, chain: typeof BASE) =>
  decodeCctpLogs(
    logs.map((l) => fromRpcLog(l, chain.chainId)),
    contracts(chain.domain),
  );

const byKind = <K extends ChainEvent["kind"]>(events: ChainEvent[], kind: K) =>
  events.filter((e): e is Extract<ChainEvent, { kind: K }> => e.kind === kind);

describe("decodeCctpLogs", () => {
  it("extracts burn + message from the Base source receipt", () => {
    const events = decode(baseToArc.sourceReceipt.logs, BASE);
    expect(events.map((e) => e.kind)).toEqual(["message_sent", "burn"]);

    const [burn] = byKind(events, "burn");
    expect(burn).toMatchObject({
      domain: 6,
      chainId: 8453,
      amount: 5_869_596n,
      destinationDomain: 26,
    });

    const [sent] = byKind(events, "message_sent");
    // V2: nonce is assigned offchain, so the source-chain copy is zeroed.
    expect(sent!.message.nonce).toBe(ZERO_BYTES32);
    expect(sent!.message.body.amount).toBe(burn!.amount);
  });

  it("extracts mint + receipt from the Arc destination receipt", () => {
    const events = decode(baseToArc.destinationReceipt.logs, ARC);
    const [mint] = byKind(events, "mint");
    const [received] = byKind(events, "message_received");
    expect(mint).toMatchObject({ amount: 5_869_596n, feeCollected: 0n });
    expect(mint!.mintRecipient).toBe(getAddress("0x299229222148e00cee5676446eed9bab5231d062"));
    expect(received).toMatchObject({
      sourceDomain: 6,
      nonce: "0x1f73af1b2ee099c698d297119d9f995d70d1682f9247bc5bbb516f8114fe68b5",
      finalityThresholdExecuted: 2000,
    });
  });

  it("ignores lookalike events emitted by other contracts", () => {
    const spoofed = baseToArc.sourceReceipt.logs.map((l) => ({
      ...l,
      address: "0x000000000000000000000000000000000000dEaD" as const,
    }));
    expect(decode(spoofed, BASE)).toEqual([]);
  });
});

describe("parseIrisMessages", () => {
  const observedAt = new Date("2026-10-07T00:00:00Z");
  const src = "0x219163cb00c8535d2b3181d4ec4df21ebad0c88e1f6de4708722b735e132e41e" as const;

  it("parses a complete attestation", () => {
    const [a] = parseIrisMessages(baseToArc.iris, 6, src, observedAt);
    expect(a).toMatchObject({ status: "complete", sourceDomain: 6, delayReason: null });
    expect(a!.attestation).toMatch(/^0x[0-9a-f]+$/);
    expect(a!.message!.body.amount).toBe(5_869_596n);
    expect(a!.nonce).toBe(a!.message!.nonce);
  });

  it("maps pending placeholders to null", () => {
    const [a] = parseIrisMessages(
      {
        messages: [
          {
            status: "pending_confirmations",
            attestation: "PENDING",
            message: "0x",
            eventNonce: "",
          },
        ],
      },
      6,
      src,
      observedAt,
    );
    expect(a).toMatchObject({
      status: "pending_confirmations",
      attestation: null,
      rawMessage: null,
      message: null,
      nonce: null,
    });
  });
});
