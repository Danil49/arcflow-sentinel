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
