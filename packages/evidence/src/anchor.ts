import {
  createPublicClient,
  decodeEventLog,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import { arc, arcTestnet } from "viem/chains";
import { evidenceRegistryAbi, traceIdToBytes32 } from "@sentinel/contracts";
import { canonicalPayloadBytes, hashPayload, type EvidenceBundle } from "./bundle.js";

export interface AnchorCheck {
  ok: boolean;
  chainId: number | null;
  blockNumber: bigint | null;
  checks: {
    txSucceeded: boolean;
    emittedByRegistry: boolean;
    traceIdMatches: boolean;
    hashMatches: boolean;
  };
  onChain: {
    traceId: Hex;
    evidenceHash: Hex;
    status: number;
    observedAt: bigint;
    submitter: Address;
  } | null;
  errors: string[];
}

const chainById = (id: number) => [arc, arcTestnet].find((c) => c.id === id);

/**
 * Checks that `txHash` emitted EvidenceAnchored from `registry` for this bundle's trace id with
 * the keccak256 recomputed from the payload (never the hash stored in the bundle). The registry
 * must come from the operator's published config: any contract can emit a lookalike event.
 */
export async function verifyAnchor(
  bundle: EvidenceBundle,
  opts: { txHash: Hex; registry: Address; rpcUrl?: string; chainId?: number },
): Promise<AnchorCheck> {
  const chain = opts.chainId ? chainById(opts.chainId) : undefined;
  const client = createPublicClient({
    chain,
    transport: http(opts.rpcUrl ?? chain?.rpcUrls.default.http[0]),
  });
  const expectedHash = hashPayload(canonicalPayloadBytes(bundle.payload)).keccak256;
  const expectedTrace = traceIdToBytes32(bundle.payload.trace.id);
  const errors: string[] = [];
  const checks = {
    txSucceeded: false,
    emittedByRegistry: false,
    traceIdMatches: false,
    hashMatches: false,
  };

  const [receipt, chainId] = await Promise.all([
    client.getTransactionReceipt({ hash: opts.txHash }).catch(() => null),
    client.getChainId(),
  ]);
  if (opts.chainId && chainId !== opts.chainId)
    errors.push(`RPC is chain ${chainId}, expected ${opts.chainId}`);
  if (!receipt) {
    errors.push("anchor transaction not found on this chain");
    return { ok: false, chainId, blockNumber: null, checks, onChain: null, errors };
  }
  checks.txSucceeded = receipt.status === "success";
  if (!checks.txSucceeded) errors.push("anchor transaction reverted");

  let onChain: AnchorCheck["onChain"] = null;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, opts.registry)) continue;
    try {
      const ev = decodeEventLog({ abi: evidenceRegistryAbi, topics: log.topics, data: log.data });
      if (ev.eventName !== "EvidenceAnchored") continue;
      checks.emittedByRegistry = true;
      onChain = ev.args;
      if (ev.args.traceId === expectedTrace) {
        checks.traceIdMatches = true;
        if (ev.args.evidenceHash.toLowerCase() === expectedHash) {
          checks.hashMatches = true;
          break;
        }
      }
    } catch {
      /* not this event */
    }
  }
  if (!checks.emittedByRegistry)
    errors.push(`no EvidenceAnchored event from registry ${opts.registry}`);
  else if (!checks.traceIdMatches) errors.push("anchored trace id differs from the bundle's trace");
  else if (!checks.hashMatches)
    errors.push("anchored hash differs from the bundle's recomputed keccak256");
  return {
    ok: Object.values(checks).every(Boolean) && errors.length === 0,
    chainId,
    blockNumber: receipt.blockNumber,
    checks,
    onChain,
    errors,
  };
}
