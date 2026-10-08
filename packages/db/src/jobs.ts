import { and, eq, sql } from "drizzle-orm";
import { toJsonSafe } from "@sentinel/core";
import type { Tx as Db } from "./repo.js";
import { jobs } from "./schema.js";

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Enqueues a job. With a dedupeKey, a second enqueue while one is queued/running is a no-op and
 * returns null.
 */
export async function enqueueJob(
  db: Db,
  type: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<bigint | null> {
  const [row] = await db
    .insert(jobs)
    .values({
      type,
      payload: toJsonSafe(payload),
      dedupeKey: opts.dedupeKey ?? null,
      runAt: opts.runAt ?? new Date(),
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

/**
 * Atomically claims up to `limit` due jobs. FOR UPDATE SKIP LOCKED lets several workers poll the
 * same table without claiming the same row. Jobs whose lock is older than `staleAfterMs`
 * (crashed worker) are claimable again.
 */
export async function claimJobs(
  db: Db,
  workerId: string,
  opts: { types?: readonly string[]; limit?: number; staleAfterMs?: number; now?: Date } = {},
): Promise<JobRow[]> {
  if (opts.types && opts.types.length === 0) return []; // explicit "no types" claims nothing
  const now = opts.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (opts.staleAfterMs ?? 5 * 60_000));
  const typeFilter = opts.types
    ? sql`and type in (${sql.join(
        opts.types.map((t) => sql`${t}`),
        sql`, `,
      )})`
    : sql``;
  const result = await db.execute<{ id: string }>(sql`
    update jobs set status = 'running', locked_at = ${now}, locked_by = ${workerId},
      attempts = attempts + 1, updated_at = ${now}
    where id in (
      select id from jobs
      where ((status = 'queued' and run_at <= ${now})
          or (status = 'running' and locked_at < ${staleBefore}))
        ${typeFilter}
      order by run_at, id
      limit ${opts.limit ?? 10}
      for update skip locked
    )
    returning id`);
  if (result.rows.length === 0) return [];
  const ids = result.rows.map((r) => BigInt(r.id));
  return db.query.jobs.findMany({
    where: (j, { inArray }) => inArray(j.id, ids),
    orderBy: (j, { asc }) => [asc(j.runAt), asc(j.id)],
  });
}

/** Lock guard: a worker whose stale lock was taken over cannot finish someone else's run. */
const ownedBy = (id: bigint, workerId: string) =>
  and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.lockedBy, workerId));

export async function completeJob(db: Db, id: bigint, workerId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "done", lockedAt: null, updatedAt: new Date() })
    .where(ownedBy(id, workerId));
}

/** Re-queues a job that made progress but is not finished (e.g. waiting for an attestation). */
export async function rescheduleJob(
  db: Db,
  id: bigint,
  workerId: string,
  runAt: Date,
  opts: { resetAttempts?: boolean; payload?: unknown } = {},
): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "queued",
      runAt,
      ...(opts.payload !== undefined ? { payload: toJsonSafe(opts.payload) } : {}),
      lockedAt: null,
      lockedBy: null,
      ...(opts.resetAttempts ? { attempts: 0, lastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(ownedBy(id, workerId));
}

export function backoffMs(attempt: number, baseMs = 2_000, capMs = 10 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}

/** Records a failure: retries with exponential backoff, or dead-letters after maxAttempts. */
export async function failJob(
  db: Db,
  job: Pick<JobRow, "id" | "attempts" | "maxAttempts">,
  workerId: string,
  error: string,
  now = new Date(),
): Promise<"retry" | "dead"> {
  const dead = job.attempts >= job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: dead ? "dead" : "queued",
      runAt: dead ? now : new Date(now.getTime() + backoffMs(job.attempts)),
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 2_000),
      updatedAt: now,
    })
    .where(ownedBy(job.id, workerId));
  return dead ? "dead" : "retry";
}
