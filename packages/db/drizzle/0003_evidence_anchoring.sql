ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_status" text;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_network" text;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_chain_id" integer;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_registry" text;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_submitter" text;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_raw_tx" text;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_block_number" bigint;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_cost_wei" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "anchor_error" text;