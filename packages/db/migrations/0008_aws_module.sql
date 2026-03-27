--> statement-breakpoint
CREATE TABLE "aws_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"role_arn" text,
	"credentials_encrypted" text,
	"external_id" text,
	"sqs_queue_url" text,
	"sqs_region" text DEFAULT 'us-east-1' NOT NULL,
	"regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"last_polled_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"poll_interval_seconds" text DEFAULT '60' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aws_integrations_org_id_account_id_unique" UNIQUE("org_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "aws_raw_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"cloudtrail_event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"event_source" text NOT NULL,
	"event_version" text,
	"aws_region" text NOT NULL,
	"principal_id" text,
	"user_arn" text,
	"account_id" text,
	"user_type" text,
	"source_ip_address" text,
	"user_agent" text,
	"error_code" text,
	"error_message" text,
	"resources" jsonb,
	"raw_payload" jsonb NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted" boolean DEFAULT false NOT NULL,
	"platform_event_id" uuid
);
--> statement-breakpoint
ALTER TABLE "aws_integrations" ADD CONSTRAINT "aws_integrations_org_id_fkey"
	FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "aws_raw_events" ADD CONSTRAINT "aws_raw_events_integration_id_fkey"
	FOREIGN KEY ("integration_id") REFERENCES "aws_integrations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "idx_aws_integration_org" ON "aws_integrations" ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_aws_raw_org" ON "aws_raw_events" ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_aws_raw_integration" ON "aws_raw_events" ("integration_id");
--> statement-breakpoint
CREATE INDEX "idx_aws_raw_received_at" ON "aws_raw_events" ("received_at");
--> statement-breakpoint
CREATE INDEX "idx_aws_raw_event_name" ON "aws_raw_events" ("event_name");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_aws_raw_cloudtrail_id" ON "aws_raw_events" ("integration_id", "cloudtrail_event_id");
