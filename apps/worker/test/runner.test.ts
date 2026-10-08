import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, jobs } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { runBatch } from "../src/index.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

const row = async (id: bigint) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

describe("runBatch", () => {
  it("completes, reschedules with new payload, and retries failures", async () => {
    const done = (await enqueueJob(t.db, "ok", {}))!;
    const wait = (await enqueueJob(t.db, "wait", { step: 1 }))!;
    const boom = (await enqueueJob(t.db, "boom", {}))!;
    const n = await runBatch({
      db: t.db,
      workerId: "w",
      handlers: {
        ok: async () => ({ kind: "done" }),
        wait: async () => ({ kind: "wait", delayMs: 60_000, payload: { step: 2 } }),
        boom: async () => {
          throw new Error("rpc down");
        },
      },
    });
    expect(n).toBe(3);
    expect((await row(done)).status).toBe("done");
    expect(await row(wait)).toMatchObject({ status: "queued", attempts: 0, payload: { step: 2 } });
    expect(await row(boom)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "Error: rpc down",
    });
  });

  it("only claims job types it has handlers for", async () => {
    const id = (await enqueueJob(t.db, "unknown", {}))!;
    expect(await runBatch({ db: t.db, workerId: "w", handlers: {} })).toBe(0);
    expect((await row(id)).status).toBe("queued");
  });
});
