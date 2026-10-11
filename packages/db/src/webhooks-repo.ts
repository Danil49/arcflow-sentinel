import { and, eq, lt, sql } from "drizzle-orm";
import { redact } from "@sentinel/config";
import { toJsonSafe } from "@sentinel/core";
import type { Tx } from "./repo.js";
import { webhookDeliveries } from "./schema.js";

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface NewDelivery {
  eventId: string;
  eventType: string;
  traceId: string | null;
  sequence: number;
  url: string;
  payload: unknown;
}

/** Idempotent on (eventId, url). Returns the ids of rows actually created. */
export async function insertDeliveries(db: Tx, rows: readonly NewDelivery[]): Promise<bigint[]> {
  if (rows.length === 0) return [];
  const inserted = await db
    .insert(webhookDeliveries)
    .values(rows.map((r) => ({ ...r, payload: toJsonSafe(r.payload) })))
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return inserted.map((r) => r.id);
}

export async function getDelivery(db: Tx, id: bigint): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
  return row;
}

/** Records one attempt. Only pending deliveries change, so a late duplicate attempt is harmless. */
export async function recordDeliveryAttempt(
  db: Tx,
  id: bigint,
  outcome: {
    status: "pending" | "delivered" | "dead";
    statusCode: number | null;
    error: string | null;
  },
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: outcome.status,
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      lastStatusCode: outcome.statusCode,
      lastError: outcome.error ? redact(outcome.error).slice(0, 1_000) : null,
      ...(outcome.status === "delivered" ? { deliveredAt: new Date() } : {}),
    })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending")));
}

/** True if an earlier event for the same trace and endpoint is still pending (ordering guard). */
export async function hasEarlierPending(db: Tx, d: WebhookDeliveryRow): Promise<boolean> {
  if (!d.traceId) return false;
  const [row] = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.traceId, d.traceId),
        eq(webhookDeliveries.url, d.url),
        eq(webhookDeliveries.status, "pending"),
        lt(webhookDeliveries.sequence, d.sequence),
      ),
    )
    .limit(1);
  return Boolean(row);
}
