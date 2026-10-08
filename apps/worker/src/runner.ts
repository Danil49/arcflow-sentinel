import { claimJobs, completeJob, failJob, rescheduleJob, type Db, type JobRow } from "@sentinel/db";

export type JobResult = { kind: "done" } | { kind: "wait"; delayMs: number; payload?: unknown };
export type JobHandler = (job: JobRow) => Promise<JobResult>;

export interface RunnerOptions {
  db: Db;
  workerId: string;
  handlers: Record<string, JobHandler>;
  batchSize?: number;
  idleMs?: number;
  signal?: AbortSignal;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Claims and runs one batch. Waiting (e.g. for an attestation) is not a failure: it requeues the
 * job and resets its attempt counter, so only real errors count toward dead-lettering.
 */
export async function runBatch(opts: RunnerOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  const claimed = await claimJobs(opts.db, opts.workerId, {
    types: Object.keys(opts.handlers),
    limit: opts.batchSize ?? 10,
  });
  await Promise.all(
    claimed.map(async (job) => {
      const handler = opts.handlers[job.type]!;
      try {
        const result = await handler(job);
        if (result.kind === "done") await completeJob(opts.db, job.id, opts.workerId);
        else {
          await rescheduleJob(
            opts.db,
            job.id,
            opts.workerId,
            new Date(Date.now() + result.delayMs),
            {
              resetAttempts: true,
              payload: result.payload,
            },
          );
        }
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        const outcome = await failJob(opts.db, job, opts.workerId, message);
        log("job failed", { jobId: job.id.toString(), type: job.type, outcome, error: message });
      }
    }),
  );
  return claimed.length;
}

/** Polls until aborted. */
export async function runJobs(opts: RunnerOptions): Promise<void> {
  while (!opts.signal?.aborted) {
    let n = 0;
    try {
      n = await runBatch(opts);
    } catch (err) {
      opts.log?.("runner batch error", { error: String(err) });
    }
    if (n === 0) await sleep(opts.idleMs ?? 1_000, opts.signal);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
