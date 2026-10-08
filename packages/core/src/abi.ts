import { parseAbi } from "viem";

/**
 * CCTP V2 event ABIs. The docs' event table (contract-interfaces.md) does not match the deployed V2
 * contracts, so these signatures were checked against the topic0 hashes of real mainnet logs.
 * See test/abi.test.ts and fixtures/base-to-arc-complete.
 */
export const tokenMessengerV2Abi = parseAbi([
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
  "event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)",
]);

export const messageTransmitterV2Abi = parseAbi([
  "event MessageSent(bytes message)",
  "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
]);

export const cctpV2EventsAbi = [...tokenMessengerV2Abi, ...messageTransmitterV2Abi] as const;
