import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit } from "../src/index.js";
import { startTestDb, type TestDb } from "./postgres.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => t.reset());

describe("consumeRateLimit", () => {
  const now = new Date("2026-10-11T12:00:30Z");

  it("allows up to the limit per window, then reports retry-after", async () => {
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await consumeRateLimit(t.db, "ip:1.2.3.4", 3, 60_000, now));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ remaining: 0, retryAfterSec: 30 });
    // Next window starts fresh; other keys are independent.
    expect(
      (await consumeRateLimit(t.db, "ip:1.2.3.4", 3, 60_000, new Date("2026-10-11T12:01:01Z")))
        .allowed,
    ).toBe(true);
    expect((await consumeRateLimit(t.db, "ip:5.6.7.8", 3, 60_000, now)).allowed).toBe(true);
  });

  it("counts atomically under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(t.db, "global", 10, 60_000, now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });
});
