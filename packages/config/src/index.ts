import { z } from "zod";
import { registerSecretsFromEnv } from "./redact.js";

export * from "./redact.js";

const url = z.url();

/** Env needed by the read-only tracing path. Later phases extend this schema. */
export const chainEnvSchema = z.object({
  CCTP_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  ARC_RPC_URL: url.optional(),
  BASE_RPC_URL: url.optional(),
  TESTNET_ARC_RPC_URL: url.optional(),
  TESTNET_BASE_RPC_URL: url.optional(),
  /** Override the max eth_getLogs block span for your RPC tier (some free tiers allow only 10). */
  ARC_LOG_CHUNK_SIZE: z.coerce.bigint().positive().optional(),
  BASE_LOG_CHUNK_SIZE: z.coerce.bigint().positive().optional(),
  IRIS_BASE_URL: url.optional(),
});
export type ChainEnv = z.infer<typeof chainEnvSchema>;

const csv = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Webhook endpoints must be HTTPS; plain HTTP is allowed only for local development. */
const webhookUrl = z.url().refine(
  (u) => {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" || (protocol === "http:" && LOCAL_HOSTS.has(hostname));
  },
  { message: "must be https (http only for localhost)" },
);

const minutes = z.coerce.number().positive();

/** Optional per-stage deadline overrides in minutes, e.g. {"mint":180,"finality":{"standard":60}}. */
export const stageDeadlinesOverrideSchema = z
  .object({
    indexing: minutes,
    finality: z.object({ standard: minutes, fast: minutes }).partial(),
    attestation: minutes,
    mint: minutes,
    mintEvent: minutes,
    applicationConfirmation: minutes,
  })
  .partial()
  .strict();
export type StageDeadlinesOverride = z.infer<typeof stageDeadlinesOverrideSchema>;

const usdcAmount = z.string().regex(/^\d+(\.\d{1,18})?$/, "must be a decimal USDC amount");

/** Evidence anchoring on Arc. Independent of CCTP_NETWORK: monitor mainnet, anchor on testnet. */
const anchorEnv = {
  /** 32-byte Ed25519 seed (hex) that signs evidence bundles. Generate: pnpm --filter @sentinel/evidence keygen */
  EVIDENCE_SIGNING_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be 32 bytes of hex")
    .optional(),
  ANCHOR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** off: never anchor; manual: only via POST /api/traces/{id}/anchor; terminal: also when a trace reaches a final state. */
  ANCHOR_MODE: z.enum(["off", "manual", "terminal"]).default("manual"),
  /** Hot key that pays anchoring gas (USDC on Arc). Use a dedicated, minimally funded account. */
  ANCHOR_PRIVATE_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be 32 bytes of hex")
    .optional(),
  /** EvidenceRegistry address on ANCHOR_NETWORK (printed by `pnpm --filter @sentinel/contracts deploy`). */
  EVIDENCE_REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be an address")
    .optional(),
  /**
   * Public address of the anchor account, published so verifiers can require it as the
   * submitter (the registry is permissionless). The web app never needs the private key.
   */
  ANCHOR_SUBMITTER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be an address")
    .optional(),
  /** Refuse to send an anchor whose worst-case fee exceeds this (USDC). */
  ANCHOR_MAX_FEE_USDC: usdcAmount.default("0.05"),
  /** Stop anchoring when the anchor account balance falls below this (USDC). */
  ANCHOR_MIN_BALANCE_USDC: usdcAmount.default("0.5"),
};

/** Env shared by everything that reads/writes traces (worker and web API). */
export const pipelineEnvSchema = chainEnvSchema
  .extend({
    ...anchorEnv,
    DATABASE_URL: z.string().min(1),
    /** Comma-separated webhook endpoints; every status change is delivered to each. */
    WEBHOOK_URLS: csv.pipe(z.array(webhookUrl)),
    /** HMAC-SHA256 key for webhook signatures; required when WEBHOOK_URLS is set. */
    WEBHOOK_SECRET: z.string().optional(),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    STAGE_DEADLINES_JSON: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v) return undefined;
        try {
          return JSON.parse(v) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "must be valid JSON" });
          return z.NEVER;
        }
      })
      .pipe(stageDeadlinesOverrideSchema.optional()),
  })
  .superRefine((env, ctx) => {
    if (env.WEBHOOK_URLS.length > 0 && (env.WEBHOOK_SECRET?.length ?? 0) < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["WEBHOOK_SECRET"],
        message: "required (>= 32 chars) when WEBHOOK_URLS is set",
      });
    }
  });
export type PipelineEnv = z.infer<typeof pipelineEnvSchema>;

export const workerEnvSchema = pipelineEnvSchema.safeExtend({
  WORKER_ID: z.string().min(1).optional(),
  /** Comma-separated chains to tail passively (arc,base). Empty = trace-driven only. */
  COLLECT: csv.pipe(z.array(z.enum(["arc", "base"]))),
  /** First block for a collector stream with no cursor yet; defaults to the current head. */
  ARC_START_BLOCK: z.coerce.bigint().nonnegative().optional(),
  BASE_START_BLOCK: z.coerce.bigint().nonnegative().optional(),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const webEnvSchema = pipelineEnvSchema.safeExtend({
  /** Bearer tokens accepted for privileged endpoints (confirm, webhook test). */
  API_KEYS: csv.pipe(z.array(z.string().min(24))),
  /**
   * Trust X-Forwarded-For (set when behind your own proxy/load balancer). Without it, clients
   * cannot be told apart safely and all anonymous traffic shares the per-client limit.
   */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** New traces per client per minute (requests with an API key are exempt). */
  RATE_LIMIT_TRACES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** New traces per minute across all anonymous clients: caps RPC spend. */
  RATE_LIMIT_TRACES_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(60),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export class EnvError extends Error {
  override name = "EnvError";
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  // `NAME=` in an env file sets an empty string; treat it as unset so optional settings and
  // defaults apply (copying .env.example and leaving fields blank must work).
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    // Report variable names only; values may be secrets.
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new EnvError(`invalid environment: ${issues}`);
  }
  // Anything parsed from env is now known to the redactor, before it can reach a log line.
  registerSecretsFromEnv(env as Record<string, string | undefined>);
  return result.data;
}
