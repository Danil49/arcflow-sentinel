import { and, desc, eq } from "drizzle-orm";
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
