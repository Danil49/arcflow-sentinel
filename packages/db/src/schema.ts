import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** uint256 token amounts: exact integers, never floats. */
const uint256 = customType<{ data: bigint; driverData: string }>({
  dataType: () => "numeric(78, 0)",
  toDriver: (value) => value.toString(),
  fromDriver: (value) => BigInt(value),
});

const blockNumber = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const transferTraces = pgTable(
  "transfer_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceChainId: integer("source_chain_id").notNull(),
    sourceDomain: integer("source_domain").notNull(),
    destinationDomain: integer("destination_domain").notNull(),
    sourceTxHash: text("source_tx_hash").notNull(),
    /** Log index of the DepositForBurn; one tx can in principle contain several burns. */
    sourceLogIndex: integer("source_log_index").notNull(),
    sourceBlockNumber: blockNumber("source_block_number").notNull(),
    /** CCTP V2 nonce; unknown until Iris attests the message. */
    messageNonce: text("message_nonce"),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    amountAtomic: uint256("amount_atomic").notNull(),
    sourceBlockTime: ts("source_block_time"),
    /** Reported status from the lifecycle reducer (FAILED_OR_STUCK when flagged). */
    status: text("status").notNull(),
    /** Furthest stage reached; differs from status only while FAILED_OR_STUCK. */
    progress: text("progress").notNull().default("SOURCE_OBSERVED"),
    /** STUCK | FAILED when status is FAILED_OR_STUCK. */
    reason: text("reason"),
    statusReason: text("status_reason"),
    destinationTxHash: text("destination_tx_hash"),
    stageDeadlineAt: ts("stage_deadline_at"),
    /** The integrating application must confirm (POST /confirm) before the trace completes. */
    requireAppConfirmation: boolean("require_app_confirmation").notNull().default(false),
    applicationConfirmedAt: ts("application_confirmed_at"),
    applicationReference: text("application_reference"),
    /** Last webhook sequence number issued for this trace (monotonic per trace). */
    webhookSeq: integer("webhook_seq").notNull().default(0),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("transfer_traces_source_uq").on(t.sourceChainId, t.sourceTxHash, t.sourceLogIndex),
    uniqueIndex("transfer_traces_nonce_uq")
      .on(t.sourceDomain, t.messageNonce)
      .where(sql`${t.messageNonce} is not null`),
    index("transfer_traces_status_idx").on(t.status),
    index("transfer_traces_deadline_idx").on(t.stageDeadlineAt),
  ],
);

export const observedEvents = pgTable(
  "observed_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    /** Null until correlated (the collector can see a mint before anyone asks for its trace). */
    traceId: uuid("trace_id").references(() => transferTraces.id),
    chainId: integer("chain_id").notNull(),
    domain: integer("domain").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    eventType: text("event_type").notNull(),
    /** CCTP nonce for message_received events, for correlation without decoding payloads. */
    nonce: text("nonce"),
    rawPayload: jsonb("raw_payload").notNull(),
    decoded: jsonb("decoded").notNull(),
    /** Set when a reorg drops the block; rows are kept as evidence, never deleted. */
    removed: boolean("removed").notNull().default(false),
    observedAt: ts("observed_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("observed_events_log_uq").on(t.chainId, t.txHash, t.logIndex),
    index("observed_events_trace_idx").on(t.traceId),
    index("observed_events_nonce_idx").on(t.nonce),
    index("observed_events_block_idx").on(t.chainId, t.blockNumber),
  ],
);

export const attestationObservations = pgTable(
  "attestation_observations",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => transferTraces.id),
    status: text("status").notNull(),
    nonce: text("nonce"),
    delayReason: text("delay_reason"),
    /** SHA-256 of the raw Iris response; identical consecutive polls are stored once. */
    responseHash: text("response_hash").notNull(),
    rawResponse: jsonb("raw_response").notNull(),
    observedAt: ts("observed_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("attestation_observations_uq").on(t.traceId, t.responseHash)],
);

export const invariantResults = pgTable(
  "invariant_results",
  {
    traceId: uuid("trace_id")
      .notNull()
      .references(() => transferTraces.id),
    ruleId: text("rule_id").notNull(),
    result: text("result", { enum: ["PASS", "FAIL", "UNKNOWN"] }).notNull(),
    explanation: text("explanation").notNull(),
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
    evaluatedAt: ts("evaluated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.traceId, t.ruleId] })],
);

/** Where each collector stream resumes. Advanced in the same transaction as the events it covers. */
export const chainCursors = pgTable("chain_cursors", {
  stream: text("stream").primaryKey(),
  chainId: integer("chain_id").notNull(),
  nextBlock: blockNumber("next_block").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Recently processed block hashes per stream, used to detect reorgs. */
export const chainBlocks = pgTable(
  "chain_blocks",
  {
    stream: text("stream").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.stream, t.blockNumber] })],
);

export const JOB_STATUSES = ["queued", "running", "done", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    /** At most one live (queued/running) job per key. */
    dedupeKey: text("dedupe_key"),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("jobs_ready_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_live_uq")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('queued', 'running')`),
  ],
);

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "dead"] as const;

/** Outbox of webhook deliveries: one row per (event, endpoint), written with the status change. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    traceId: uuid("trace_id").references(() => transferTraces.id),
    sequence: integer("sequence").notNull(),
    url: text("url").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    deliveredAt: ts("delivered_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_url_uq").on(t.eventId, t.url),
    index("webhook_deliveries_trace_idx").on(t.traceId, t.sequence),
  ],
);

/**
 * Sealed evidence bundles. One row per distinct payload hash: re-requesting evidence for an
 * unchanged trace returns the same row. Anchoring (Phase 5) fills the anchor columns.
 */
export const evidenceBundles = pgTable(
  "evidence_bundles",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => transferTraces.id),
    schemaVersion: text("schema_version").notNull(),
    sha256: text("sha256").notNull(),
    keccak256: text("keccak256").notNull(),
    keyId: text("key_id").notNull(),
    status: text("status").notNull(),
    bundle: jsonb("bundle").notNull(),
    anchorTxHash: text("anchor_tx_hash"),
    anchoredAt: ts("anchored_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("evidence_bundles_hash_uq").on(t.traceId, t.keccak256),
    index("evidence_bundles_trace_idx").on(t.traceId, t.createdAt),
  ],
);
