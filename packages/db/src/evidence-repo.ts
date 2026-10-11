import { and, desc, eq } from "drizzle-orm";
import { redact } from "@sentinel/config";
import type { Tx } from "./repo.js";
import { evidenceBundles } from "./schema.js";

export type EvidenceBundleRow = typeof evidenceBundles.$inferSelect;

export interface NewEvidenceBundle {
  traceId: string;
  schemaVersion: string;
  sha256: string;
  keccak256: string;
  keyId: string;
  status: string;
  bundle: unknown;
}

/** Idempotent on (traceId, keccak256): the same evidence is stored once. */
export async function upsertEvidenceBundle(
  db: Tx,
  b: NewEvidenceBundle,
): Promise<EvidenceBundleRow> {
  const [inserted] = await db
    .insert(evidenceBundles)
    .values({ ...b, keccak256: b.keccak256.toLowerCase() })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(evidenceBundles)
    .where(
      and(
        eq(evidenceBundles.traceId, b.traceId),
        eq(evidenceBundles.keccak256, b.keccak256.toLowerCase()),
      ),
    );
  return existing!;
}

export async function listEvidenceBundles(db: Tx, traceId: string): Promise<EvidenceBundleRow[]> {
  return db
    .select()
    .from(evidenceBundles)
    .where(eq(evidenceBundles.traceId, traceId))
    .orderBy(desc(evidenceBundles.createdAt), desc(evidenceBundles.id));
}

export async function getEvidenceBundle(
  db: Tx,
  id: bigint,
): Promise<EvidenceBundleRow | undefined> {
  const [row] = await db.select().from(evidenceBundles).where(eq(evidenceBundles.id, id));
  return row;
}

export interface AnchorSubmission {
  network: string;
  chainId: number;
  registry: string;
  submitter: string;
  txHash: string;
  rawTx: string;
}

/** Durable intent: written (and committed) before the raw tx is broadcast. */
export async function markAnchorSubmitted(db: Tx, id: bigint, s: AnchorSubmission): Promise<void> {
  await db
    .update(evidenceBundles)
    .set({
      anchorStatus: "submitted",
      anchorNetwork: s.network,
      anchorChainId: s.chainId,
      anchorRegistry: s.registry.toLowerCase(),
      anchorSubmitter: s.submitter.toLowerCase(),
      anchorTxHash: s.txHash.toLowerCase(),
      anchorRawTx: s.rawTx,
      anchorError: null,
    })
    .where(eq(evidenceBundles.id, id));
}

export async function markAnchorConfirmed(
  db: Tx,
  id: bigint,
  c: { blockNumber: bigint; costWei: bigint; at: Date },
): Promise<void> {
  await db
    .update(evidenceBundles)
    .set({
      anchorStatus: "confirmed",
      anchorBlockNumber: c.blockNumber,
      anchorCostWei: c.costWei,
      anchoredAt: c.at,
      anchorRawTx: null,
      anchorError: null,
    })
    .where(eq(evidenceBundles.id, id));
}

export async function markAnchorFailed(db: Tx, id: bigint, error: string): Promise<void> {
  await db
    .update(evidenceBundles)
    .set({ anchorStatus: "failed", anchorRawTx: null, anchorError: redact(error).slice(0, 1_000) })
    .where(eq(evidenceBundles.id, id));
}
