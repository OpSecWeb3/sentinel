CREATE TABLE "payload_field_catalog" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_type" text NOT NULL,
	"field_path" text NOT NULL,
	"field_type" text DEFAULT 'string' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payload_catalog_path" ON "payload_field_catalog" USING btree ("source","source_type","field_path");--> statement-breakpoint
CREATE INDEX "idx_payload_catalog_source" ON "payload_field_catalog" USING btree ("source","source_type");