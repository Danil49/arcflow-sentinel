import { lt, sql } from "drizzle-orm";
import type { Tx } from "./repo.js";
import { rateLimitWindows } from "./schema.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window ends. */
  retryAfterSec: number;
}

/**
 * Counts one request against `key` in a fixed window and reports whether it is within `limit`.
 * Atomic (single upsert), so concurrent web instances share the same counter.
 */
export async function consumeRateLimit(
  db: Tx,
  key: string,
  limit: number,
  windowMs: number,
  now = new Date(),
): Promise<RateLimitResult> {
  const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const [row] = await db
    .insert(rateLimitWindows)
    .values({ key, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitWindows.key, rateLimitWindows.windowStart],
      set: { count: sql`${rateLimitWindows.count} + 1` },
    })
    .returning({ count: rateLimitWindows.count });
  const count = row!.count;
  // Opportunistic cleanup of expired windows (~1% of calls).
  if (Math.random() < 0.01) {
    await db
      .delete(rateLimitWindows)
      .where(lt(rateLimitWindows.windowStart, new Date(now.getTime() - 60 * windowMs)));
  }
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSec: Math.max(1, Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000)),
  };
}
