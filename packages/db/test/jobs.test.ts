import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimJobs, completeJob, enqueueJob, failJob, jobs, rescheduleJob } from "../src/index.js";
import { startTestDb, type TestDb } from "./postgres.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

const row = async (id: bigint) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

describe("job queue", () => {
  it("dedupes live jobs by key, allows re-enqueue once done", async () => {
    const id = (await enqueueJob(
      t.db,
      "trace.refresh",
      { traceId: "x" },
      { dedupeKey: "trace:x" },
    ))!;
    expect(await enqueueJob(t.db, "trace.refresh", {}, { dedupeKey: "trace:x" })).toBeNull();
    const [job] = await claimJobs(t.db, "w1");
    await completeJob(t.db, job!.id, "w1");
    expect(job!.id).toBe(id);
    expect(await enqueueJob(t.db, "trace.refresh", {}, { dedupeKey: "trace:x" })).not.toBeNull();
  });

  it("concurrent claimers never receive the same job", async () => {
    for (let i = 0; i < 50; i++) await enqueueJob(t.db, "t", { i });
    const batches = await Promise.all(
      Array.from({ length: 5 }, (_, w) => claimJobs(t.db, `w${w}`, { limit: 20 })),
    );
    const ids = batches.flat().map((j) => j.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it("respects run_at and type filters", async () => {
    await enqueueJob(t.db, "later", {}, { runAt: new Date(Date.now() + 60_000) });
    await enqueueJob(t.db, "other", {});
    expect(await claimJobs(t.db, "w", { types: ["later"] })).toHaveLength(0);
    expect((await claimJobs(t.db, "w")).map((j) => j.type)).toEqual(["other"]);
  });

  it("retries with backoff then dead-letters", async () => {
    const id = (await enqueueJob(t.db, "t", {}, { maxAttempts: 2 }))!;
    let [job] = await claimJobs(t.db, "w");
    expect(await failJob(t.db, job!, "w", "boom 1")).toBe("retry");
    expect((await row(id)).runAt.getTime()).toBeGreaterThan(Date.now());

    [job] = await claimJobs(t.db, "w", { now: new Date(Date.now() + 3_600_000) });
    expect(await failJob(t.db, job!, "w", "boom 2")).toBe("dead");
    expect(await row(id)).toMatchObject({ status: "dead", attempts: 2, lastError: "boom 2" });
  });

  it("reclaims stale locks and ignores completion from the old owner", async () => {
    const id = (await enqueueJob(t.db, "t", {}))!;
    await claimJobs(t.db, "crashed");
    const later = new Date(Date.now() + 10 * 60_000);
    const [job] = await claimJobs(t.db, "w2", { now: later });
    expect(job?.id).toBe(id);
    await completeJob(t.db, id, "crashed");
    expect((await row(id)).status).toBe("running");
    await completeJob(t.db, id, "w2");
    expect((await row(id)).status).toBe("done");
  });

  it("reschedule can reset attempts for jobs that are waiting, not failing", async () => {
    const id = (await enqueueJob(t.db, "t", {}))!;
    await claimJobs(t.db, "w");
    await rescheduleJob(t.db, id, "w", new Date(Date.now() + 1_000), { resetAttempts: true });
    expect(await row(id)).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
  });
});

describe("persisted errors are redacted", () => {
  it("strips RPC URL paths (API keys) from job errors", async () => {
    const id = (await enqueueJob(t.db, "t", {}))!;
    const [job] = await claimJobs(t.db, "w");
    await failJob(
      t.db,
      job!,
      "w",
      "HttpRequestError: URL: https://arc-mainnet.g.alchemy.com/v2/SECRETKEY123456789",
    );
    expect((await row(id)).lastError).toBe(
      "HttpRequestError: URL: https://arc-mainnet.g.alchemy.com/<redacted>",
    );
  });
});
