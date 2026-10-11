import { anchorChain, IRIS_BASE_URL, type AnchorNetwork, type RouteChain } from "@sentinel/chains";
import { registryAddress } from "@sentinel/contracts";
import { parseEnv, webEnvSchema } from "@sentinel/config";
import { connect, type Db } from "@sentinel/db";
import { signerFromSeed, type EvidenceSigner } from "@sentinel/evidence";
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
  network: "mainnet" | "testnet";
  /** Null when EVIDENCE_SIGNING_KEY is not configured (evidence endpoints then return 503). */
  signer: EvidenceSigner | null;
  /**
   * Where evidence is anchored. The web app never holds the anchor key: it only queues
   * evidence.anchor jobs, which the worker signs. Null registry = anchoring unavailable.
   */
  anchor: {
    mode: "off" | "manual" | "terminal";
    network: AnchorNetwork;
    chainId: number;
    registry: `0x${string}` | null;
    explorerTxUrl: (hash: string) => string;
  };
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
    network: env.CCTP_NETWORK,
    signer: env.EVIDENCE_SIGNING_KEY ? signerFromSeed(env.EVIDENCE_SIGNING_KEY) : null,
    anchor: {
      mode: env.ANCHOR_MODE,
      network: env.ANCHOR_NETWORK,
      chainId: anchorChain(env.ANCHOR_NETWORK).chain.id,
      registry: registryAddress(env.ANCHOR_NETWORK, env.EVIDENCE_REGISTRY_ADDRESS),
      explorerTxUrl: anchorChain(env.ANCHOR_NETWORK).explorerTxUrl,
    },
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
