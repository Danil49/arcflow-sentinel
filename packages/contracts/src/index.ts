import { parseAbi, type Hex } from "viem";
import artifact from "../artifacts/EvidenceRegistry.json" with { type: "json" };
import mainnetDeployment from "../deployments/mainnet.json" with { type: "json" };
import testnetDeployment from "../deployments/testnet.json" with { type: "json" };

/** Typed ABI (test/artifact.test.ts asserts it equals the compiled one). */
export const evidenceRegistryAbi = parseAbi([
  "event EvidenceAnchored(bytes32 indexed traceId, bytes32 indexed evidenceHash, uint8 status, uint64 observedAt, address indexed submitter)",
  "function anchor(bytes32 traceId, bytes32 evidenceHash, uint8 status, uint64 observedAt)",
]);

export const evidenceRegistryBytecode = artifact.bytecode as Hex;
export const evidenceRegistryArtifact = artifact;

/**
 * The `status` byte stored with an anchor. Stable wire values: never renumber, only append.
 * FAILED_OR_STUCK is split by reason so the on-chain record keeps the distinction.
 */
export const ANCHOR_STATUS = {
  UNKNOWN: 0,
  SOURCE_OBSERVED: 1,
  FINALITY_WAIT: 2,
  ATTESTATION_PENDING: 3,
  ATTESTED: 4,
  DESTINATION_SUBMITTED: 5,
  MINT_CONFIRMED: 6,
  APPLICATION_CONFIRMED: 7,
  FAILED: 8,
  STUCK: 9,
} as const;

export function anchorStatusCode(status: string, reason: string | null): number {
  if (status === "FAILED_OR_STUCK")
    return reason === "FAILED" ? ANCHOR_STATUS.FAILED : ANCHOR_STATUS.STUCK;
  return ANCHOR_STATUS[status as keyof typeof ANCHOR_STATUS] ?? ANCHOR_STATUS.UNKNOWN;
}

/** UUID trace id -> bytes32 (16 bytes of the UUID, left-aligned, zero-padded). */
export function traceIdToBytes32(uuid: string): Hex {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a UUID: ${uuid}`);
  return `0x${hex}${"0".repeat(32)}`;
}

export interface RegistryDeployment {
  network: "testnet" | "mainnet";
  chainId: number;
  address: `0x${string}`;
  txHash: string;
  blockNumber: string;
}

/** Committed deployments (deployments/<network>.json), verified against the artifact on deploy. */
export const REGISTRY_DEPLOYMENTS: Partial<Record<"testnet" | "mainnet", RegistryDeployment>> = {
  testnet: testnetDeployment as RegistryDeployment,
  mainnet: mainnetDeployment as RegistryDeployment,
};

/** EVIDENCE_REGISTRY_ADDRESS wins; otherwise the committed deployment for the network, if any. */
export function registryAddress(
  network: "testnet" | "mainnet",
  override?: string,
): `0x${string}` | null {
  return (override as `0x${string}` | undefined) ?? REGISTRY_DEPLOYMENTS[network]?.address ?? null;
}
