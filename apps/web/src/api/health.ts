import { sql } from "drizzle-orm";
import type { RouteChain } from "@sentinel/chains";
import type { ApiContext } from "../context.js";
import { json } from "../http.js";

export const getLive = async () => json({ status: "ok" });

/** Ready = can serve traffic: the database answers. */
export async function getReady(ctx: ApiContext): Promise<Response> {
  try {
    await ctx.db.execute(sql`select 1`);
    return json({ status: "ok", checks: { database: "ok" } });
  } catch {
    return json({ status: "unavailable", checks: { database: "error" } }, 503);
  }
}

interface Probe {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function probe<T>(fn: () => Promise<T>): Promise<Probe & { value?: T }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ok: true, latencyMs: Math.round(performance.now() - t0), value };
  } catch (err) {
    // Error messages from RPC clients can embed the endpoint URL (and API key): never echo them.
    return { ok: false, latencyMs: Math.round(performance.now() - t0), error: (err as Error).name };
  }
}

let cache: { at: number; body: unknown; status: number } | null = null;
const CACHE_MS = 15_000;

/** Route health: chain heads and Iris reachability. Cached so it cannot be used to amplify load. */
export async function getRoutes(ctx: ApiContext): Promise<Response> {
  const nowMs = ctx.now().getTime();
  if (cache && nowMs - cache.at < CACHE_MS) return json(cache.body, cache.status);

  const chains = await Promise.all(
    (Object.keys(ctx.sides) as RouteChain[]).map(async (key) => {
      const side = ctx.sides[key];
      const p = await probe(() => side.client.getBlockNumber());
      return {
        chain: key,
        chainId: side.config.chain.id,
        domain: side.config.domain,
        ok: p.ok,
        latencyMs: p.latencyMs,
        headBlock: p.value?.toString() ?? null,
        ...(p.error ? { error: p.error } : {}),
      };
    }),
  );
  const iris = await probe(async () => {
    // A known-missing lookup: 404 means Iris is up and answering.
    const res = await fetch(
      new URL(`/v2/messages/6?transactionHash=0x${"0".repeat(64)}`, ctx.irisBaseUrl),
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (res.status !== 404 && !res.ok) throw new Error(`HTTP ${res.status}`);
  });
  const ok = chains.every((c) => c.ok) && iris.ok;
  const body = {
    status: ok ? "ok" : "degraded",
    route: "arc<->base",
    chains,
    iris: { ok: iris.ok, latencyMs: iris.latencyMs, ...(iris.error ? { error: iris.error } : {}) },
    checkedAt: ctx.now().toISOString(),
  };
  cache = { at: nowMs, body, status: ok ? 200 : 503 };
  return json(body, cache.status);
}

/** Test hook. */
export const resetRoutesCache = () => {
  cache = null;
};
