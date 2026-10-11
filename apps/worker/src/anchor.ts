import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  http,
  isAddressEqual,
  keccak256,
  parseTransaction,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anchorChain, arcFees, parseNativeUsdc, type AnchorNetwork } from "@sentinel/chains";
import type { PipelineEnv } from "@sentinel/config";
import {
  anchorStatusCode,
  evidenceRegistryAbi,
  registryAddress,
  traceIdToBytes32,
} from "@sentinel/contracts";
import {
  getEvidenceBundle,
  markAnchorConfirmed,
  markAnchorFailed,
  markAnchorSubmitted,
  type Db,
  type EvidenceBundleRow,
} from "@sentinel/db";
import type { EvidenceBundle, EvidencePayload, EvidenceSigner } from "@sentinel/evidence";
import { sealTraceEvidence } from "./evidence.js";

export const EVIDENCE_ANCHOR = "evidence.anchor";

export class AnchorPolicyError extends Error {
  override name = "AnchorPolicyError";
}

export interface Anchorer {
  network: AnchorNetwork;
  chainId: number;
  registry: Address;
  account: Account;
  client: PublicClient;
  wallet: WalletClient;
  maxFeeWei: bigint;
  minBalanceWei: bigint;
  explorerTxUrl: (hash: string) => string;
}

/** Null unless anchoring is enabled and fully configured (key + registry for the network). */
export function anchorerFromEnv(env: PipelineEnv): Anchorer | null {
  if (env.ANCHOR_MODE === "off" || !env.ANCHOR_PRIVATE_KEY) return null;
  const registry = registryAddress(env.ANCHOR_NETWORK, env.EVIDENCE_REGISTRY_ADDRESS);
  if (!registry) return null;
  const cfg = anchorChain(env.ANCHOR_NETWORK);
  const rpcUrl = env.ANCHOR_NETWORK === "mainnet" ? env.ARC_RPC_URL : env.TESTNET_ARC_RPC_URL;
  const key = env.ANCHOR_PRIVATE_KEY.startsWith("0x")
    ? env.ANCHOR_PRIVATE_KEY
    : `0x${env.ANCHOR_PRIVATE_KEY}`;
  const account = privateKeyToAccount(key as Hex);
  const transport = http(rpcUrl, { timeout: 15_000, retryCount: 2 });
  return {
    network: env.ANCHOR_NETWORK,
    chainId: cfg.chain.id,
    registry,
    account,
    client: createPublicClient({ chain: cfg.chain, transport }),
    wallet: createWalletClient({ chain: cfg.chain, account, transport }),
    maxFeeWei: parseNativeUsdc(env.ANCHOR_MAX_FEE_USDC),
    minBalanceWei: parseNativeUsdc(env.ANCHOR_MIN_BALANCE_USDC),
    explorerTxUrl: cfg.explorerTxUrl,
  };
}

/** Latest observation time in the bundle: stable for unchanged evidence (unlike "now"). */
export function evidenceObservedAt(bundle: EvidenceBundle): bigint {
  const times = [
    ...bundle.payload.observations.chainEvents.map((e) => e.observedAt),
    ...bundle.payload.observations.attestations.map((a) => a.observedAt),
  ].map((t) => Date.parse(t));
  return BigInt(Math.floor(Math.max(0, ...times) / 1000));
}

export type AnchorOutcome =
  | { kind: "confirmed"; row: EvidenceBundleRow; txHash: Hex; alreadyAnchored: boolean }
  | { kind: "failed"; row: EvidenceBundleRow; error: string };

/**
 * Seals the trace's current evidence and anchors its keccak256 on Arc. Idempotent and
 * crash-safe:
 * - the same evidence is anchored once (a confirmed bundle is returned as-is);
 * - the signed raw tx is persisted before broadcast, so a crash at any point resumes by
 *   rebroadcasting the very same tx (same nonce and hash) rather than sending a second one;
 * - signing + broadcasting run under a Postgres advisory lock per account, so concurrent
 *   workers never race for a nonce.
 * Spending is bounded: it refuses when the worst-case fee exceeds the cap or the balance is low.
 */
export async function anchorTrace(
  db: Db,
  anchorer: Anchorer,
  traceId: string,
  signer: EvidenceSigner,
  payloadNetwork: EvidencePayload["network"],
): Promise<AnchorOutcome | null> {
  const sealed = await sealTraceEvidence(db, traceId, signer, payloadNetwork);
  if (!sealed) return null;
  let row = sealed.row;
  if (row.anchorStatus === "confirmed" && row.anchorTxHash) {
    return { kind: "confirmed", row, txHash: row.anchorTxHash as Hex, alreadyAnchored: true };
  }

  if (row.anchorStatus !== "submitted" || !row.anchorRawTx || !row.anchorTxHash) {
    await withAccountLock(db, anchorer.account.address, async () => {
      const fresh = (await getEvidenceBundle(db, row.id))!;
      if (fresh.anchorStatus === "submitted" || fresh.anchorStatus === "confirmed") return; // another worker won
      const raw = await signAnchorTx(anchorer, sealed.bundle, traceId);
      await markAnchorSubmitted(db, row.id, {
        network: anchorer.network,
        chainId: anchorer.chainId,
        registry: anchorer.registry,
        submitter: anchorer.account.address,
        txHash: keccak256(raw),
        rawTx: raw,
      });
      await broadcast(anchorer, raw);
    });
    row = (await getEvidenceBundle(db, row.id))!;
  } else {
    await broadcast(anchorer, row.anchorRawTx as Hex); // resume after a crash: same tx again
  }
  if (row.anchorStatus === "confirmed") {
    return { kind: "confirmed", row, txHash: row.anchorTxHash as Hex, alreadyAnchored: true };
  }

  const txHash = row.anchorTxHash as Hex;
  let receipt;
  try {
    receipt = await anchorer.client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  } catch (err) {
    // Not mined. If the account's nonce already moved past ours, something else used that nonce
    // (e.g. the key was used elsewhere): this tx can never land, so fail it and allow a re-anchor.
    const ourNonce = row.anchorRawTx ? parseTransaction(row.anchorRawTx as Hex).nonce : undefined;
    const confirmed = await anchorer.client.getTransactionCount({
      address: anchorer.account.address,
      blockTag: "latest",
    });
    if (
      ourNonce !== undefined &&
      confirmed > ourNonce &&
      !(await anchorer.client.getTransaction({ hash: txHash }).catch(() => null))
    ) {
      const error = `anchor tx ${txHash} was replaced: nonce ${ourNonce} used by another transaction`;
      await markAnchorFailed(db, row.id, error);
      return { kind: "failed", row: (await getEvidenceBundle(db, row.id))!, error };
    }
    throw err; // still pending: the job retries and resumes
  }
  if (receipt.status !== "success") {
    const error = `anchor tx ${txHash} reverted`;
    await markAnchorFailed(db, row.id, error);
    return { kind: "failed", row: (await getEvidenceBundle(db, row.id))!, error };
  }
  const matched = receipt.logs.some((log) => {
    if (!isAddressEqual(log.address, anchorer.registry)) return false;
    try {
      const ev = decodeEventLog({ abi: evidenceRegistryAbi, topics: log.topics, data: log.data });
      return (
        ev.eventName === "EvidenceAnchored" &&
        ev.args.traceId === traceIdToBytes32(traceId) &&
        ev.args.evidenceHash.toLowerCase() === row.keccak256.toLowerCase()
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    const error = `anchor tx ${txHash} has no matching EvidenceAnchored log`;
    await markAnchorFailed(db, row.id, error);
    return { kind: "failed", row: (await getEvidenceBundle(db, row.id))!, error };
  }
  await markAnchorConfirmed(db, row.id, {
    blockNumber: receipt.blockNumber,
    costWei: receipt.gasUsed * receipt.effectiveGasPrice,
    at: new Date(),
  });
  return {
    kind: "confirmed",
    row: (await getEvidenceBundle(db, row.id))!,
    txHash,
    alreadyAnchored: false,
  };
}

async function signAnchorTx(a: Anchorer, bundle: EvidenceBundle, traceId: string): Promise<Hex> {
  const args = [
    traceIdToBytes32(traceId),
    bundle.hashes.keccak256,
    anchorStatusCode(bundle.payload.verdict.status, bundle.payload.verdict.reason),
    evidenceObservedAt(bundle),
  ] as const;
  const data = encodeFunctionData({ abi: evidenceRegistryAbi, functionName: "anchor", args });
  const [balance, fees, nonce, gasEstimate] = await Promise.all([
    a.client.getBalance({ address: a.account.address }),
    arcFees(a.client),
    a.client.getTransactionCount({ address: a.account.address, blockTag: "pending" }),
    a.client.estimateGas({ account: a.account, to: a.registry, data }),
  ]);
  const gas = (gasEstimate * 12n) / 10n;
  const worstCase = gas * fees.maxFeePerGas;
  const usdc = (v: bigint) => `${formatUnits(v, 18)} USDC`;
  if (worstCase > a.maxFeeWei) {
    throw new AnchorPolicyError(
      `worst-case fee ${usdc(worstCase)} exceeds ANCHOR_MAX_FEE_USDC ${usdc(a.maxFeeWei)}`,
    );
  }
  if (balance - worstCase < a.minBalanceWei) {
    throw new AnchorPolicyError(
      `anchor balance ${usdc(balance)} would fall below ANCHOR_MIN_BALANCE_USDC ${usdc(a.minBalanceWei)}`,
    );
  }
  return a.wallet.signTransaction({
    account: a.account,
    chain: a.client.chain,
    to: a.registry,
    data,
    gas,
    nonce,
    type: "eip1559",
    ...fees,
  });
}

/** Broadcasting the same signed tx twice is harmless; "already known" style errors mean it is in. */
async function broadcast(a: Anchorer, raw: Hex): Promise<void> {
  try {
    await a.client.sendRawTransaction({ serializedTransaction: raw });
  } catch (err) {
    const msg = String((err as Error).message ?? err).toLowerCase();
    if (/already known|known transaction|nonce too low|already imported/.test(msg)) return;
    throw err;
  }
}

/** Session-level advisory lock on a dedicated connection: one signer per account at a time. */
async function withAccountLock<T>(db: Db, account: Address, fn: () => Promise<T>): Promise<T> {
  type Conn = { query(sql: string, params: unknown[]): Promise<unknown>; release(): void };
  const pool = (db as unknown as { $client: { connect(): Promise<Conn> } }).$client;
  const conn = await pool.connect();
  const key = `anchor:${account.toLowerCase()}`;
  try {
    await conn.query("select pg_advisory_lock(hashtext($1))", [key]);
    return await fn();
  } finally {
    await conn.query("select pg_advisory_unlock(hashtext($1))", [key]).catch(() => {});
    conn.release();
  }
}
