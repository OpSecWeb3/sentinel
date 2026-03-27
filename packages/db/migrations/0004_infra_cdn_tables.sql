-- Migration: Add CDN provider config and origin record tables
-- Part of infra module CDN integration for origin IP detection on proxied hosts

CREATE TABLE IF NOT EXISTS "infra_cdn_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"host_pattern" text,
	"encrypted_credentials" text NOT NULL,
	"is_valid" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_infra_cdn_provider_pattern" ON "infra_cdn_provider_configs" ("org_id","provider","host_pattern");
CREATE INDEX IF NOT EXISTS "idx_infra_cdn_provider_org" ON "infra_cdn_provider_configs" ("org_id");

CREATE TABLE IF NOT EXISTS "infra_cdn_origin_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL REFERENCES "infra_hosts"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"record_type" text NOT NULL,
	"record_value" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_infra_cdn_origin_host_type_value" ON "infra_cdn_origin_records" ("host_id","record_type","record_value");
CREATE INDEX IF NOT EXISTS "idx_infra_cdn_origin_host" ON "infra_cdn_origin_records" ("host_id");
