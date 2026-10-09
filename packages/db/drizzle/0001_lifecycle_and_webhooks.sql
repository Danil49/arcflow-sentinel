CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"trace_id" uuid,
	"sequence" integer NOT NULL,
	"url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "source_block_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "progress" text DEFAULT 'SOURCE_OBSERVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "destination_tx_hash" text;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "stage_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "require_app_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "application_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "application_reference" text;--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "webhook_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_trace_id_transfer_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."transfer_traces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_url_uq" ON "webhook_deliveries" USING btree ("event_id","url");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_trace_idx" ON "webhook_deliveries" USING btree ("trace_id","sequence");--> statement-breakpoint
CREATE INDEX "transfer_traces_deadline_idx" ON "transfer_traces" USING btree ("stage_deadline_at");