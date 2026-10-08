import { getAddress, hexToBigInt, hexToNumber, size, slice, type Address, type Hex } from "viem";

// CCTP V2 message layout: https://developers.circle.com/cctp/references/technical-guide.md
const HEADER_LENGTH = 148;
const BURN_BODY_MIN_LENGTH = 228;

export interface MessageHeaderV2 {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /** Zeroed in the source-chain MessageSent log; Circle assigns it offchain at attestation time. */
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  /** Zeroed in the source-chain MessageSent log; set by the attester. */
  finalityThresholdExecuted: number;
  messageBody: Hex;
}

export interface BurnMessageBodyV2 {
  version: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  /** Zeroed on the source chain; set by the attester. */
  feeExecuted: bigint;
  /** Zeroed on the source chain; set by the attester. */
  expirationBlock: bigint;
  hookData: Hex;
}

export class MessageDecodeError extends Error {
  override name = "MessageDecodeError";
}

const u32 = (data: Hex, offset: number) =>
  hexToNumber(slice(data, offset, offset + 4, { strict: true }));
const b32 = (data: Hex, offset: number) => slice(data, offset, offset + 32, { strict: true });
const u256 = (data: Hex, offset: number) => hexToBigInt(b32(data, offset));

export function decodeMessageHeaderV2(message: Hex): MessageHeaderV2 {
  if (size(message) < HEADER_LENGTH) {
    throw new MessageDecodeError(`message too short: ${size(message)} < ${HEADER_LENGTH} bytes`);
  }
  return {
    version: u32(message, 0),
    sourceDomain: u32(message, 4),
    destinationDomain: u32(message, 8),
    nonce: b32(message, 12),
    sender: b32(message, 44),
    recipient: b32(message, 76),
    destinationCaller: b32(message, 108),
    minFinalityThreshold: u32(message, 140),
    finalityThresholdExecuted: u32(message, 144),
    messageBody: size(message) === HEADER_LENGTH ? "0x" : slice(message, HEADER_LENGTH),
  };
}

export function decodeBurnMessageBodyV2(body: Hex): BurnMessageBodyV2 {
  if (size(body) < BURN_BODY_MIN_LENGTH) {
    throw new MessageDecodeError(
      `burn body too short: ${size(body)} < ${BURN_BODY_MIN_LENGTH} bytes`,
    );
  }
  return {
    version: u32(body, 0),
    burnToken: b32(body, 4),
    mintRecipient: b32(body, 36),
    amount: u256(body, 68),
    messageSender: b32(body, 100),
    maxFee: u256(body, 132),
    feeExecuted: u256(body, 164),
    expirationBlock: u256(body, 196),
    hookData: size(body) === BURN_BODY_MIN_LENGTH ? "0x" : slice(body, BURN_BODY_MIN_LENGTH),
  };
}

export interface BurnMessageV2 extends Omit<MessageHeaderV2, "messageBody"> {
  body: BurnMessageBodyV2;
}

export function decodeBurnMessageV2(message: Hex): BurnMessageV2 {
  const { messageBody, ...header } = decodeMessageHeaderV2(message);
  return { ...header, body: decodeBurnMessageBodyV2(messageBody) };
}

/** EVM addresses are left-padded to bytes32 in CCTP messages. */
export function bytes32ToAddress(value: Hex): Address {
  if (size(value) !== 32)
    throw new MessageDecodeError(`expected bytes32, got ${size(value)} bytes`);
  if (slice(value, 0, 12) !== "0x000000000000000000000000") {
    throw new MessageDecodeError(`bytes32 is not a left-padded EVM address: ${value}`);
  }
  return getAddress(slice(value, 12));
}

export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;
