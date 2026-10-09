import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  enqueueJob,
  getDelivery,
  hasEarlierPending,
  insertDeliveries,
  recordDeliveryAttempt,
  type JobRow,
  type StatusChange,
  type Tx,
} from "@sentinel/db";
import type { JobHandler } from "./runner.js";

export const WEBHOOK_DELIVER = "webhook.deliver";
export const WEBHOOK_MAX_ATTEMPTS = 10;

export interface WebhookConfig {
  urls: readonly string[];
  secret: string;
  timeoutMs: number;
}

export interface WebhookEvent {
  id: string;
  type: "trace.status_changed" | "webhook.test";
  createdAt: string;
  /** Monotonic per trace; receivers should ignore events older than the last one processed. */
  sequence: number;
  data: Record<string, unknown>;
}

/**
 * Signature over `${timestamp}.${body}` (Stripe-style), so a captured request cannot be replayed
 * with a fresh timestamp. Receivers should reject timestamps older than a few minutes.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Reference verifier for receivers (and tests). Constant-time comparison. */
export function verifyWebhook(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  opts: { now?: number; toleranceSec?: number } = {},
): boolean {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function enqueueEvent(
  tx: Tx,
  config: WebhookConfig,
  event: WebhookEvent,
  traceId: string | null,
) {
  const ids = await insertDeliveries(
    tx,
    config.urls.map((url) => ({
      eventId: event.id,
      eventType: event.type,
      traceId,
      sequence: event.sequence,
      url,
      payload: event,
    })),
  );
  for (const id of ids) {
    await enqueueJob(
      tx,
      WEBHOOK_DELIVER,
      { deliveryId: id.toString() },
      {
        dedupeKey: `${WEBHOOK_DELIVER}:${id}`,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      },
    );
  }
}

/** saveLifecycle callback: writes one delivery per endpoint in the status-change transaction. */
export function webhookOutbox(config: WebhookConfig | null) {
  return async (tx: Tx, change: StatusChange) => {
    if (!config || config.urls.length === 0) return;
    const { trace, result, previous } = change;
    await enqueueEvent(
      tx,
      config,
      {
        id: randomUUID(),
        type: "trace.status_changed",
        createdAt: new Date().toISOString(),
        sequence: change.sequence,
        data: {
          traceId: trace.id,
          status: result.status,
          previousStatus: previous.status,
          progress: result.progress,
          reason: result.reason,
          statusReason: result.statusReason,
          sourceDomain: trace.sourceDomain,
          destinationDomain: trace.destinationDomain,
          sourceTxHash: trace.sourceTxHash,
          destinationTxHash: result.destinationTxHash,
          nonce: result.nonce,
          amountAtomic: trace.amountAtomic.toString(),
          recipient: trace.recipient,
          invariants: Object.fromEntries(result.invariants.map((i) => [i.ruleId, i.result])),
        },
      },
      trace.id,
    );
  };
}

export async function enqueueTestWebhook(tx: Tx, config: WebhookConfig): Promise<string> {
  const id = randomUUID();
  await enqueueEvent(
    tx,
    config,
    { id, type: "webhook.test", createdAt: new Date().toISOString(), sequence: 0, data: {} },
    null,
  );
  return id;
}

/**
 * Delivers one webhook. Events for one trace reach each endpoint in sequence order (a later event
 * waits while an earlier one is pending). Non-2xx and network errors throw, so the job queue
 * retries with backoff; the final attempt marks the delivery dead (which unblocks later events).
 * Redirects are not followed (a 3xx is a failure).
 */
export function createWebhookHandler(
  db: Tx,
  config: WebhookConfig,
  fetchImpl: typeof fetch = fetch,
): JobHandler {
  return async (job: JobRow) => {
    const { deliveryId } = job.payload as { deliveryId: string };
    const delivery = await getDelivery(db, BigInt(deliveryId));
    if (!delivery || delivery.status !== "pending") return { kind: "done" };
    // Per (trace, endpoint) ordering: wait until earlier events are delivered or dead.
    if (await hasEarlierPending(db, delivery)) return { kind: "wait", delayMs: 1_000 };

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const lastAttempt = job.attempts >= job.maxAttempts;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetchImpl(delivery.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: {
          "content-type": "application/json",
          "user-agent": "arcflow-sentinel-webhooks/1",
          "x-sentinel-event-id": delivery.eventId,
          "x-sentinel-event-type": delivery.eventType,
          "x-sentinel-sequence": String(delivery.sequence),
          "x-sentinel-timestamp": String(timestamp),
          "x-sentinel-retry": String(job.attempts - 1),
          "x-sentinel-signature": signWebhook(config.secret, timestamp, body),
        },
        body,
      });
      statusCode = res.status;
      await res.body?.cancel();
      if (res.ok) {
        await recordDeliveryAttempt(db, delivery.id, {
          status: "delivered",
          statusCode,
          error: null,
        });
        return { kind: "done" };
      }
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    await recordDeliveryAttempt(db, delivery.id, {
      status: lastAttempt ? "dead" : "pending",
      statusCode,
      error,
    });
    if (lastAttempt) return { kind: "done" };
    throw new Error(`webhook delivery ${delivery.id} failed: ${error}`);
  };
}
