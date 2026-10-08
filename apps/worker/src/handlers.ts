import type { JobRow } from "@sentinel/db";
import { TRACE_CREATE, type TraceCreatePayload } from "./collector.js";
import type { JobHandler, JobResult } from "./runner.js";
import {
  createTraces,
  refreshTrace,
  TRACE_REFRESH,
  type PipelineDeps,
  type TraceRefreshPayload,
} from "./services.js";

/** Pipeline deps per route direction, keyed by source CCTP domain. */
export type Directions = Record<number, PipelineDeps>;

const forDomain = (directions: Directions, domain: number) => {
  const deps = directions[domain];
  if (!deps) throw new Error(`no route configured for source domain ${domain}`);
  return deps;
};

export function createHandlers(directions: Directions): Record<string, JobHandler> {
  return {
    [TRACE_CREATE]: async (job: JobRow): Promise<JobResult> => {
      const p = job.payload as TraceCreatePayload;
      await createTraces(forDomain(directions, p.sourceDomain), p.sourceTxHash);
      return { kind: "done" };
    },
    [TRACE_REFRESH]: async (job: JobRow): Promise<JobResult> => {
      const p = job.payload as TraceRefreshPayload;
      const outcome = await refreshTrace(forDomain(directions, p.sourceDomain), p);
      return outcome.kind === "done"
        ? { kind: "done" }
        : { kind: "wait", delayMs: outcome.delayMs, payload: outcome.payload };
    },
  };
}
