import { and, eq, sql } from "drizzle-orm";
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
      lastError: outcome.error?.slice(0, 1_000) ?? null,
      ...(outcome.status === "delivered" ? { deliveredAt: new Date() } : {}),
    })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending")));
}
