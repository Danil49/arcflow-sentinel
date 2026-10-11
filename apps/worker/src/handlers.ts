import { enqueueJob, type Db, type JobRow } from "@sentinel/db";
import type { EvidencePayload, EvidenceSigner } from "@sentinel/evidence";
import { anchorTrace, EVIDENCE_ANCHOR, type Anchorer } from "./anchor.js";
import { TRACE_CREATE, type TraceCreatePayload } from "./collector.js";
import type { JobHandler, JobResult } from "./runner.js";
import {
  createTraces,
  refreshTrace,
  TRACE_REFRESH,
  type PipelineDeps,
  type TraceRefreshPayload,
} from "./services.js";
import { createWebhookHandler, WEBHOOK_DELIVER, type WebhookConfig } from "./webhooks.js";

/** Pipeline deps per route direction, keyed by source CCTP domain. */
export type Directions = Record<number, PipelineDeps>;

const forDomain = (directions: Directions, domain: number) => {
  const deps = directions[domain];
  if (!deps) throw new Error(`no route configured for source domain ${domain}`);
  return deps;
};

export interface AnchorOptions {
  db: Db;
  anchorer: Anchorer;
  signer: EvidenceSigner;
  payloadNetwork: EvidencePayload["network"];
  /** "terminal": also anchor automatically once a trace reaches a final state. */
  mode: "manual" | "terminal";
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export const anchorJobKey = (traceId: string) => `${EVIDENCE_ANCHOR}:${traceId}`;

export function createHandlers(
  directions: Directions,
  webhooks?: { db: Db; config: WebhookConfig | null; fetch?: typeof fetch },
  anchor?: AnchorOptions | null,
): Record<string, JobHandler> {
  const handlers: Record<string, JobHandler> = {
    [TRACE_CREATE]: async (job: JobRow): Promise<JobResult> => {
      const p = job.payload as TraceCreatePayload;
      await createTraces(forDomain(directions, p.sourceDomain), p.sourceTxHash);
      return { kind: "done" };
    },
    [TRACE_REFRESH]: async (job: JobRow): Promise<JobResult> => {
      const p = job.payload as TraceRefreshPayload;
      const deps = forDomain(directions, p.sourceDomain);
      const outcome = await refreshTrace(deps, p);
      if (outcome.kind === "done" && anchor?.mode === "terminal") {
        await enqueueJob(
          deps.db,
          EVIDENCE_ANCHOR,
          { traceId: p.traceId },
          { dedupeKey: anchorJobKey(p.traceId) },
        );
      }
      return outcome.kind === "done"
        ? { kind: "done" }
        : { kind: "wait", delayMs: outcome.delayMs, payload: outcome.payload };
    },
  };
  if (anchor) {
    handlers[EVIDENCE_ANCHOR] = async (job: JobRow): Promise<JobResult> => {
      const { traceId } = job.payload as { traceId: string };
      const r = await anchorTrace(
        anchor.db,
        anchor.anchorer,
        traceId,
        anchor.signer,
        anchor.payloadNetwork,
      );
      if (r?.kind === "failed") anchor.log?.("anchor failed", { traceId, error: r.error });
      if (r?.kind === "confirmed" && !r.alreadyAnchored) {
        anchor.log?.("anchored", { traceId, network: anchor.anchorer.network, tx: r.txHash });
      }
      return { kind: "done" };
    };
  }
  if (webhooks?.config) {
    handlers[WEBHOOK_DELIVER] = createWebhookHandler(webhooks.db, webhooks.config, webhooks.fetch);
  }
  return handlers;
}
