CREATE TABLE "attestation_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"nonce" text,
	"delay_reason" text,
	"response_hash" text NOT NULL,
	"raw_response" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_blocks" (
	"stream" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	CONSTRAINT "chain_blocks_stream_block_number_pk" PRIMARY KEY("stream","block_number")
);
--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"stream" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"next_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invariant_results" (
	"trace_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"result" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invariant_results_trace_id_rule_id_pk" PRIMARY KEY("trace_id","rule_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observed_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trace_id" uuid,
	"chain_id" integer NOT NULL,
	"domain" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"event_type" text NOT NULL,
	"nonce" text,
	"raw_payload" jsonb NOT NULL,
	"decoded" jsonb NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_chain_id" integer NOT NULL,
	"source_domain" integer NOT NULL,
	"destination_domain" integer NOT NULL,
	"source_tx_hash" text NOT NULL,
	"source_log_index" integer NOT NULL,
	"source_block_number" bigint NOT NULL,
	"message_nonce" text,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"amount_atomic" numeric(78, 0) NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attestation_observations" ADD CONSTRAINT "attestation_observations_trace_id_transfer_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."transfer_traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invariant_results" ADD CONSTRAINT "invariant_results_trace_id_transfer_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."transfer_traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observed_events" ADD CONSTRAINT "observed_events_trace_id_transfer_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."transfer_traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attestation_observations_uq" ON "attestation_observations" USING btree ("trace_id","response_hash");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_live_uq" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" is not null and "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "observed_events_log_uq" ON "observed_events" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "observed_events_trace_idx" ON "observed_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "observed_events_nonce_idx" ON "observed_events" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "observed_events_block_idx" ON "observed_events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_traces_source_uq" ON "transfer_traces" USING btree ("source_chain_id","source_tx_hash","source_log_index");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_traces_nonce_uq" ON "transfer_traces" USING btree ("source_domain","message_nonce") WHERE "transfer_traces"."message_nonce" is not null;--> statement-breakpoint
CREATE INDEX "transfer_traces_status_idx" ON "transfer_traces" USING btree ("status");