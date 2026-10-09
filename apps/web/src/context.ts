import { IRIS_BASE_URL, type RouteChain } from "@sentinel/chains";
import { parseEnv, webEnvSchema } from "@sentinel/config";
import { connect, type Db } from "@sentinel/db";
import {
  createIrisClient,
  resolveDeadlines,
  routeSidesFromEnv,
  type PipelineDeps,
  type RouteSide,
  type WebhookConfig,
} from "@sentinel/worker";

/** Everything a request handler needs. Built once per process; tests inject their own. */
export interface ApiContext {
  db: Db;
  sides: Record<RouteChain, RouteSide>;
  /** Pipeline deps for traces whose source is the given chain. */
  pipeline: (source: RouteChain) => PipelineDeps;
  webhooks: WebhookConfig | null;
  apiKeys: readonly string[];
  irisBaseUrl: string;
  now: () => Date;
}

export function contextFromEnv(env = parseEnv(webEnvSchema)): ApiContext {
  const { db } = connect(env.DATABASE_URL);
  const sides = routeSidesFromEnv(env);
  const irisBaseUrl = env.IRIS_BASE_URL ?? IRIS_BASE_URL[env.CCTP_NETWORK];
  const iris = createIrisClient(irisBaseUrl);
  const webhooks: WebhookConfig | null = env.WEBHOOK_URLS.length
    ? { urls: env.WEBHOOK_URLS, secret: env.WEBHOOK_SECRET!, timeoutMs: env.WEBHOOK_TIMEOUT_MS }
    : null;
  const deadlines = resolveDeadlines(env.STAGE_DEADLINES_JSON);
  return {
    db,
    sides,
    pipeline: (source) => ({
      db,
      iris,
      deadlines,
      webhooks,
      source: sides[source],
      destination: sides[source === "arc" ? "base" : "arc"],
    }),
    webhooks,
    apiKeys: env.API_KEYS,
    irisBaseUrl,
    now: () => new Date(),
  };
}

let current: ApiContext | null = null;

export function getContext(): ApiContext {
  current ??= contextFromEnv();
  return current;
}

/** Test hook: route handlers then use the given context. */
export function setContext(ctx: ApiContext | null): void {
  current = ctx;
}
