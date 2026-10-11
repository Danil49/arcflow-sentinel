import { hostname } from "node:os";
import { IRIS_BASE_URL, type RouteChain } from "@sentinel/chains";
import { parseEnv, workerEnvSchema } from "@sentinel/config";
import { connect } from "@sentinel/db";
import { collectorTick, type CollectorOptions } from "./collector.js";
import { routeSidesFromEnv } from "./env.js";
import { createHandlers } from "./handlers.js";
import { signerFromSeed } from "@sentinel/evidence";
import { anchorerFromEnv } from "./anchor.js";
import { createIrisClient } from "./iris.js";
import { runJobs } from "./runner.js";
import { resolveDeadlines } from "./services.js";
import type { WebhookConfig } from "./webhooks.js";

const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...fields }));

const env = parseEnv(workerEnvSchema);
const workerId = env.WORKER_ID ?? `${hostname()}-${process.pid}`;
const { db, close } = connect(env.DATABASE_URL);
const sides = routeSidesFromEnv(env);
const iris = createIrisClient(env.IRIS_BASE_URL ?? IRIS_BASE_URL[env.CCTP_NETWORK]);

const deadlines = resolveDeadlines(env.STAGE_DEADLINES_JSON);
const webhooks: WebhookConfig | null = env.WEBHOOK_URLS.length
  ? { urls: env.WEBHOOK_URLS, secret: env.WEBHOOK_SECRET!, timeoutMs: env.WEBHOOK_TIMEOUT_MS }
  : null;
const common = { db, iris, deadlines, webhooks };
const directions = {
  [sides.base.config.domain]: { ...common, source: sides.base, destination: sides.arc },
  [sides.arc.config.domain]: { ...common, source: sides.arc, destination: sides.base },
};

const anchorer = anchorerFromEnv(env);
const anchorOptions =
  anchorer && env.EVIDENCE_SIGNING_KEY && env.ANCHOR_MODE !== "off"
    ? {
        db,
        anchorer,
        signer: signerFromSeed(env.EVIDENCE_SIGNING_KEY),
        payloadNetwork: env.CCTP_NETWORK,
        mode: env.ANCHOR_MODE,
        log,
      }
    : null;

const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    log("shutting down", { signal: sig });
    abort.abort();
  });
}

async function runCollector(key: RouteChain) {
  const side = sides[key];
  const peer = key === "arc" ? sides.base : sides.arc;
  const start = key === "arc" ? env.ARC_START_BLOCK : env.BASE_START_BLOCK;
  const opts: CollectorOptions = {
    db,
    side,
    peerDomain: peer.config.domain,
    startBlock: start ?? (await side.client.getBlockNumber()),
    confirmations: key === "arc" ? 0n : 5n,
    checkReorgs: key !== "arc",
  };
  let failures = 0;
  while (!abort.signal.aborted) {
    try {
      const r = await collectorTick(opts);
      failures = 0;
      if (r.kind === "processed" && r.stored > 0) log("collected", { chain: key, ...stringify(r) });
      if (r.kind === "reorg")
        log("reorg detected", { chain: key, rewoundTo: r.rewoundTo.toString() });
      if (r.kind === "idle") await sleep(key === "arc" ? 1_000 : 2_000);
    } catch (err) {
      failures++;
      log("collector error", { chain: key, error: String(err), failures });
      await sleep(Math.min(60_000, 1_000 * 2 ** failures));
    }
  }
}

const stringify = (o: object) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    abort.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

log("worker starting", {
  workerId,
  network: env.CCTP_NETWORK,
  collect: env.COLLECT,
  webhookEndpoints: webhooks?.urls.length ?? 0,
  anchoring: anchorOptions
    ? {
        network: anchorer!.network,
        registry: anchorer!.registry,
        account: anchorer!.account.address,
        mode: env.ANCHOR_MODE,
      }
    : "disabled",
});
await Promise.all([
  runJobs({
    db,
    workerId,
    handlers: createHandlers(directions, { db, config: webhooks }, anchorOptions),
    signal: abort.signal,
    log,
  }),
  ...env.COLLECT.map(runCollector),
]);
await close();
log("worker stopped");
