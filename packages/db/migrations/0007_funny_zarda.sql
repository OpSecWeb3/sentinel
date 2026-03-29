ALTER TABLE "infra_cdn_provider_configs" ALTER COLUMN "host_pattern" SET DEFAULT '*';--> statement-breakpoint
ALTER TABLE "infra_cdn_provider_configs" ALTER COLUMN "host_pattern" SET NOT NULL;