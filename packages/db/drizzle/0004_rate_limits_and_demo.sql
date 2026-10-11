CREATE TABLE "rate_limit_windows" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_windows_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "transfer_traces" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "rate_limit_windows_start_idx" ON "rate_limit_windows" USING btree ("window_start");