CREATE TABLE "evidence_bundles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trace_id" uuid NOT NULL,
	"schema_version" text NOT NULL,
	"sha256" text NOT NULL,
	"keccak256" text NOT NULL,
	"key_id" text NOT NULL,
	"status" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"anchor_tx_hash" text,
	"anchored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD CONSTRAINT "evidence_bundles_trace_id_transfer_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."transfer_traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_bundles_hash_uq" ON "evidence_bundles" USING btree ("trace_id","keccak256");--> statement-breakpoint
CREATE INDEX "evidence_bundles_trace_idx" ON "evidence_bundles" USING btree ("trace_id","created_at");