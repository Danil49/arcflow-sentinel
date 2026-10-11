import { z } from "zod";
import { LIFECYCLE_STATES } from "@sentinel/core";

export const txHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte 0x-prefixed hex hash");
export const traceId = z.uuid();
export const chainKey = z.enum(["base", "arc"]);

export const createTraceBody = z
  .object({
    sourceTxHash: txHash,
    sourceChain: chainKey,
    /** Requires an API key: lets the integrating app hold completion until it confirms. */
    requireAppConfirmation: z.boolean().optional(),
  })
  .strict();

export const traceLookupQuery = z.object({ sourceTxHash: txHash, sourceChain: chainKey });

export const confirmBody = z.object({ reference: z.string().min(1).max(200).optional() }).strict();

const iso = z.string().describe("ISO-8601 timestamp");
const hex = z.string().describe("0x-prefixed hex");

export const traceDto = z.object({
  id: z.uuid(),
  route: z.object({
    sourceChain: chainKey,
    sourceDomain: z.number().int(),
    destinationChain: chainKey,
    destinationDomain: z.number().int(),
  }),
  sourceTxHash: hex,
  sourceLogIndex: z.number().int(),
  sourceBlockNumber: z.string().describe("decimal block number"),
  sourceBlockTime: iso.nullable(),
  nonce: hex.nullable(),
  sender: hex,
  recipient: hex,
  amountAtomic: z.string().describe("USDC amount in 6-decimal atomic units (decimal string)"),
  status: z.enum(LIFECYCLE_STATES),
  progress: z.enum(LIFECYCLE_STATES),
  reason: z.enum(["STUCK", "FAILED"]).nullable(),
  statusReason: z.string().nullable(),
  destinationTxHash: hex.nullable(),
  stageDeadlineAt: iso.nullable(),
  requireAppConfirmation: z.boolean(),
  applicationConfirmedAt: iso.nullable(),
  applicationReference: z.string().nullable(),
  isDemo: z.boolean().describe("seeded from historical fixtures for demonstration"),
  explorer: z.object({ source: z.url(), destination: z.url().nullable() }),
  firstSeenAt: iso,
  updatedAt: iso,
});
export type TraceDto = z.infer<typeof traceDto>;

export const tracesResponse = z.object({ traces: z.array(traceDto) });

export const invariantDto = z.object({
  ruleId: z.string(),
  result: z.enum(["PASS", "FAIL", "UNKNOWN"]),
  explanation: z.string(),
  evidenceRefs: z.array(z.string()),
  evaluatedAt: iso,
});

export const eventsResponse = z.object({
  events: z.array(
    z.object({
      chainId: z.number().int(),
      domain: z.number().int(),
      blockNumber: z.string(),
      blockHash: hex,
      txHash: hex,
      logIndex: z.number().int(),
      eventType: z.enum(["burn", "message_sent", "message_received", "mint"]),
      removed: z.boolean().describe("dropped by a chain reorganization; kept as evidence"),
      observedAt: iso,
      decoded: z.record(z.string(), z.unknown()),
    }),
  ),
  attestations: z.array(
    z.object({
      status: z.string(),
      nonce: hex.nullable(),
      delayReason: z.string().nullable(),
      responseHash: z.string().describe("SHA-256 of the raw Iris response"),
      observedAt: iso,
    }),
  ),
});

export const problemDto = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
