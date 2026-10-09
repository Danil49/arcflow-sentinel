import { z } from "zod";

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

/** Env shared by everything that reads/writes traces (worker and web API). */
export const pipelineEnvSchema = chainEnvSchema
  .extend({
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
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export class EnvError extends Error {
  override name = "EnvError";
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report variable names only; values may be secrets.
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new EnvError(`invalid environment: ${issues}`);
  }
  return result.data;
}
