import type { Address, Hex } from "viem";
import type { BurnMessageV2 } from "./message.js";

/** Canonical business lifecycle, frozen per idea.md. The reducer only moves forward through it. */
export const LIFECYCLE_STATES = [
  "SOURCE_OBSERVED",
  "FINALITY_WAIT",
  "ATTESTATION_PENDING",
  "ATTESTED",
  "DESTINATION_SUBMITTED",
  "MINT_CONFIRMED",
  "APPLICATION_CONFIRMED",
  "FAILED_OR_STUCK",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** Why a trace is in FAILED_OR_STUCK. STUCK = deadline exceeded without failure evidence. */
export type StuckOrFailedReason = "STUCK" | "FAILED";

/** A log as observed on chain, independent of the RPC client's number representation. */
export interface ObservedLog {
  chainId: number;
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

export interface LogRef {
  chainId: number;
  domain: number;
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  /** When Sentinel first stored this log (set when loaded from the DB; used for stage timing). */
  observedAt?: Date;
}

export interface BurnObserved extends LogRef {
  kind: "burn";
  burnToken: Address;
  amount: bigint;
  depositor: Address;
  mintRecipient: Hex;
  destinationDomain: number;
  destinationTokenMessenger: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
}

export interface MessageSentObserved extends LogRef {
  kind: "message_sent";
  rawMessage: Hex;
  message: BurnMessageV2;
}

export interface MessageReceivedObserved extends LogRef {
  kind: "message_received";
  caller: Address;
  sourceDomain: number;
  nonce: Hex;
  sender: Hex;
  finalityThresholdExecuted: number;
  messageBody: Hex;
}

export interface MintObserved extends LogRef {
  kind: "mint";
  mintRecipient: Address;
  amount: bigint;
  mintToken: Address;
  feeCollected: bigint;
}

export type ChainEvent =
  BurnObserved | MessageSentObserved | MessageReceivedObserved | MintObserved;

/** Iris /v2/messages status values observed so far. Unknown values are preserved, not dropped. */
export type AttestationStatus = "pending_confirmations" | "complete" | (string & {});

export interface AttestationObserved {
  kind: "attestation";
  sourceDomain: number;
  sourceTxHash: Hex;
  status: AttestationStatus;
  nonce: Hex | null;
  rawMessage: Hex | null;
  message: BurnMessageV2 | null;
  attestation: Hex | null;
  delayReason: string | null;
  observedAt: Date;
}

export type DomainEvent = ChainEvent | AttestationObserved;
