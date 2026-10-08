import { decodeEventLog, isAddressEqual, isHex, type Address, type Hex } from "viem";
import { cctpV2EventsAbi } from "./abi.js";
import { decodeBurnMessageV2 } from "./message.js";
import type { AttestationObserved, ChainEvent, LogRef, ObservedLog } from "./types.js";

export interface CctpContracts {
  domain: number;
  tokenMessenger: Address;
  messageTransmitter: Address;
}

/**
 * Turns raw logs into typed CCTP events. Only logs emitted by the configured CCTP contracts are
 * considered: any contract can emit an event with the same signature, so the address is the trust
 * boundary.
 */
export function decodeCctpLogs(
  logs: readonly ObservedLog[],
  contracts: CctpContracts,
): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const log of logs) {
    const fromMessenger = isAddressEqual(log.address, contracts.tokenMessenger);
    const fromTransmitter = isAddressEqual(log.address, contracts.messageTransmitter);
    if (!fromMessenger && !fromTransmitter) continue;

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: cctpV2EventsAbi,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
    } catch {
      continue; // other events from the same contracts (ownership, config, ...)
    }

    const ref: LogRef = {
      chainId: log.chainId,
      domain: contracts.domain,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    };

    switch (decoded.eventName) {
      case "DepositForBurn":
        if (fromMessenger) events.push({ kind: "burn", ...ref, ...decoded.args });
        break;
      case "MintAndWithdraw":
        if (fromMessenger) events.push({ kind: "mint", ...ref, ...decoded.args });
        break;
      case "MessageSent":
        if (fromTransmitter) {
          events.push({
            kind: "message_sent",
            ...ref,
            rawMessage: decoded.args.message,
            message: decodeBurnMessageV2(decoded.args.message),
          });
        }
        break;
      case "MessageReceived":
        if (fromTransmitter) events.push({ kind: "message_received", ...ref, ...decoded.args });
        break;
    }
  }
  return events;
}

/** Shape of a JSON-RPC log (eth_getLogs / receipt.logs), all quantities hex-encoded. */
export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export function fromRpcLog(log: RpcLog, chainId: number): ObservedLog {
  return {
    chainId,
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: BigInt(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: Number(log.logIndex),
  };
}

/** Shape of Circle Iris GET /v2/messages/{sourceDomain} responses (fields we rely on). */
export interface IrisMessagesResponse {
  messages?: Array<{
    status: string;
    eventNonce?: string | null;
    message?: string | null;
    attestation?: string | null;
    delayReason?: string | null;
    cctpVersion?: number;
  }>;
}

const hexOrNull = (value: string | null | undefined): Hex | null =>
  value && isHex(value) && value !== "0x" ? value : null;

/**
 * Iris returns placeholders ("PENDING", "0x") while an attestation is not ready; those are mapped
 * to null so downstream code never mistakes them for real data.
 */
export function parseIrisMessages(
  response: IrisMessagesResponse,
  sourceDomain: number,
  sourceTxHash: Hex,
  observedAt: Date,
): AttestationObserved[] {
  return (response.messages ?? [])
    .filter((m) => m.cctpVersion === undefined || m.cctpVersion === 2)
    .map((m) => {
      const rawMessage = hexOrNull(m.message);
      return {
        kind: "attestation",
        sourceDomain,
        sourceTxHash,
        status: m.status,
        nonce: hexOrNull(m.eventNonce),
        rawMessage,
        message: rawMessage ? decodeBurnMessageV2(rawMessage) : null,
        attestation: hexOrNull(m.attestation),
        delayReason: m.delayReason ?? null,
        observedAt,
      };
    });
}
