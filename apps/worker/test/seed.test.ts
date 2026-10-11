import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getInvariantResults, getTrace, transferTraces } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { seedDemo } from "../src/index.js";

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

describe("seedDemo", () => {
  it("loads both real fixtures as completed, flagged demo traces, idempotently, offline", async () => {
    const first = await seedDemo({ db: t.db }, fixtures);
    expect(first.map((s) => [s.name, s.status])).toEqual([
      ["arc-to-base-complete", "MINT_CONFIRMED"],
      ["base-to-arc-complete", "MINT_CONFIRMED"],
    ]);
    const second = await seedDemo({ db: t.db }, fixtures);
    expect(second.map((s) => s.traceId)).toEqual(first.map((s) => s.traceId));
    expect(await t.db.select().from(transferTraces)).toHaveLength(2);
    for (const s of first) {
      expect(await getTrace(t.db, s.traceId)).toMatchObject({
        isDemo: true,
        status: "MINT_CONFIRMED",
      });
      expect((await getInvariantResults(t.db, s.traceId)).every((i) => i.result === "PASS")).toBe(
        true,
      );
    }
  });
});
