CREATE TABLE "aws_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"account_id" text NOT NULL,
	"is_org_integration" boolean DEFAULT false NOT NULL,
	"aws_org_id" text,
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
	"poll_interval_seconds" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "chain_block_cursors" (
	"network_id" integer PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_container_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"container_name" text NOT NULL,
	"cpu_percent" real NOT NULL,
	"memory_usage_mb" real NOT NULL,
	"memory_limit_mb" real NOT NULL,
	"memory_percent" real NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"network_id" integer NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"abi" jsonb NOT NULL,
	"is_proxy" boolean DEFAULT false NOT NULL,
	"implementation" text,
	"fetched_at" timestamp with time zone,
	"storage_layout" jsonb,
	"layout_status" text,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_detection_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"icon" text,
	"severity_default" text DEFAULT 'high' NOT NULL,
	"tier" text DEFAULT 'mvp' NOT NULL,
	"inputs" jsonb NOT NULL,
	"rule_templates" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_detection_templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "chain_networks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"chain_key" text NOT NULL,
	"chain_id" integer NOT NULL,
	"rpc_url" text NOT NULL,
	"block_time_ms" integer NOT NULL,
	"explorer_url" text,
	"explorer_api" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "chain_networks_slug_unique" UNIQUE("slug"),
	CONSTRAINT "chain_networks_chain_key_unique" UNIQUE("chain_key")
);
--> statement-breakpoint
CREATE TABLE "chain_org_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contract_id" integer NOT NULL,
	"label" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_org_rpc_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"network_id" integer NOT NULL,
	"rpc_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_rpc_usage_hourly" (
	"bucket" timestamp with time zone NOT NULL,
	"org_id" text DEFAULT '_system' NOT NULL,
	"network_slug" text NOT NULL,
	"template_slug" text DEFAULT '_unknown' NOT NULL,
	"detection_id" text DEFAULT '_system' NOT NULL,
	"rpc_method" text NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chain_rpc_usage_hourly_bucket_org_id_network_slug_template_slug_detection_id_rpc_method_status_pk" PRIMARY KEY("bucket","org_id","network_slug","template_slug","detection_id","rpc_method","status")
);
--> statement-breakpoint
CREATE TABLE "chain_state_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"detection_id" uuid,
	"network_id" integer NOT NULL,
	"address" text NOT NULL,
	"snapshot_type" text NOT NULL,
	"slot" text,
	"value" text NOT NULL,
	"block_number" bigint,
	"polled_at" timestamp with time zone NOT NULL,
	"triggered" boolean DEFAULT false NOT NULL,
	"trigger_context" jsonb
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"detection_id" uuid,
	"rule_id" uuid,
	"event_id" uuid,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_data" jsonb NOT NULL,
	"notification_status" text DEFAULT 'pending' NOT NULL,
	"notifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '["read"]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid,
	"module_id" text NOT NULL,
	"template_id" text,
	"name" text NOT NULL,
	"description" text,
	"severity" text DEFAULT 'high' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"slack_channel_id" text,
	"slack_channel_name" text,
	"cooldown_minutes" integer DEFAULT 0 NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"alert_id" bigint NOT NULL,
	"channel_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_code" integer,
	"response_time_ms" integer,
	"error" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"invite_secret_hash" text,
	"invite_secret_encrypted" text,
	"webhook_secret_encrypted" text,
	"notify_key_hash" text,
	"notify_key_prefix" text,
	"notify_key_last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detection_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"rule_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"action" text DEFAULT 'alert' NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp with time zone NOT NULL,
	"user_id" uuid,
	"org_id" uuid
);
--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"bot_token" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"installed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "correlation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"description" text,
	"severity" text DEFAULT 'high' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"slack_channel_id" text,
	"slack_channel_name" text,
	"cooldown_minutes" integer DEFAULT 0 NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"app_slug" text NOT NULL,
	"target_type" text NOT NULL,
	"target_login" text NOT NULL,
	"target_id" bigint NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "github_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"visibility" text NOT NULL,
	"default_branch" text,
	"archived" boolean DEFAULT false NOT NULL,
	"fork" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_cdn_origin_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"record_type" text NOT NULL,
	"record_value" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_cdn_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"host_pattern" text DEFAULT '*' NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"is_valid" boolean DEFAULT false NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"subject" text NOT NULL,
	"issuer" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"chain_valid" boolean DEFAULT true NOT NULL,
	"san_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_type" text,
	"key_size" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_ct_log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"crt_sh_id" bigint NOT NULL,
	"serial_number" text NOT NULL,
	"issuer" text NOT NULL,
	"common_name" text NOT NULL,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"entry_timestamp" timestamp with time zone,
	"is_new" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_dns_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"change_type" text NOT NULL,
	"severity" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_dns_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"dnssec_enabled" boolean DEFAULT false NOT NULL,
	"dnssec_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"caa_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dmarc_record" text,
	"dmarc_policy" text,
	"spf_record" text,
	"spf_valid" boolean DEFAULT false NOT NULL,
	"dangling_cnames" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_dns_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_value" text NOT NULL,
	"ttl" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_finding_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"category" text NOT NULL,
	"issue" text NOT NULL,
	"reason" text,
	"suppressed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"hostname" text NOT NULL,
	"is_root" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"current_score" integer,
	"last_scanned_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_http_header_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"hsts_present" boolean DEFAULT false NOT NULL,
	"hsts_max_age" integer,
	"hsts_include_subdomains" boolean DEFAULT false NOT NULL,
	"hsts_preload" boolean DEFAULT false NOT NULL,
	"csp_present" boolean DEFAULT false NOT NULL,
	"csp_header" text,
	"x_frame_options" text,
	"x_content_type_options" boolean DEFAULT false NOT NULL,
	"referrer_policy" text,
	"permissions_policy_present" boolean DEFAULT false NOT NULL,
	"permissions_policy_header" text,
	"server_header_present" boolean DEFAULT false NOT NULL,
	"server_header_value" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_reachability_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"dns_resolved" boolean DEFAULT false NOT NULL,
	"is_reachable" boolean DEFAULT false NOT NULL,
	"http_status" integer,
	"response_time_ms" integer,
	"dns_changed" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_scan_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"scan_request_id" text,
	"scan_type" text NOT NULL,
	"status" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_scan_events_scan_request_id_unique" UNIQUE("scan_request_id")
);
--> statement-breakpoint
CREATE TABLE "infra_scan_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 1440 NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"probe_enabled" boolean DEFAULT false NOT NULL,
	"probe_interval_minutes" integer DEFAULT 5 NOT NULL,
	"probe_last_run_at" timestamp with time zone,
	"probe_next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_scan_step_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_event_id" uuid NOT NULL,
	"step_type" text NOT NULL,
	"status" text NOT NULL,
	"result_data" jsonb,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_score_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"grade" text,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"ip_address" text NOT NULL,
	"ip_version" integer NOT NULL,
	"geo_country" text,
	"geo_city" text,
	"geo_lat" real,
	"geo_lon" real,
	"cloud_provider" text,
	"reverse_dns_name" text,
	"open_ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asn" text,
	"asn_org" text,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_tls_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"tls_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cipher_suites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_exchange" text,
	"cert_key_type" text,
	"cert_key_size" integer,
	"has_tls13" boolean DEFAULT false NOT NULL,
	"has_tls12" boolean DEFAULT false NOT NULL,
	"has_tls11" boolean DEFAULT false NOT NULL,
	"has_tls10" boolean DEFAULT false NOT NULL,
	"has_weak_ciphers" boolean DEFAULT false NOT NULL,
	"weak_cipher_list" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_whois_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_whois_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"registrar" text,
	"registration_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"updated_date" timestamp with time zone,
	"name_servers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dnssec_signed" boolean DEFAULT false NOT NULL,
	"raw_whois" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rc_artifact_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_id" uuid,
	"artifact_event_type" text NOT NULL,
	"version" text NOT NULL,
	"old_digest" text,
	"new_digest" text,
	"pusher" text,
	"source" text DEFAULT 'poll' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rc_artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" text NOT NULL,
	"current_digest" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"digest_changed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"verification" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rc_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"name" text NOT NULL,
	"registry" text DEFAULT 'docker_hub' NOT NULL,
	"tag_watch_patterns" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"tag_ignore_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"watch_mode" text DEFAULT 'dist-tags' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"poll_interval_seconds" integer DEFAULT 300 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"github_repo" text,
	"github_allowed_workflows" jsonb DEFAULT '[]'::jsonb,
	"webhook_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"credentials_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rc_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_event_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"ci_run_id" bigint,
	"commit" text,
	"actor" text,
	"workflow" text,
	"repo" text,
	"details" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rc_ci_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_name" text NOT NULL,
	"artifact_type" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL,
	"github_run_id" bigint NOT NULL,
	"github_commit" text NOT NULL,
	"github_actor" text NOT NULL,
	"github_workflow" text NOT NULL,
	"github_repo" text NOT NULL,
	"verified" boolean DEFAULT false,
	"verification_details" jsonb,
	"matched_artifact_event_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rc_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"digest" text,
	"has_signature" boolean DEFAULT false NOT NULL,
	"signature_key_id" text,
	"signature_issuer" text,
	"has_provenance" boolean DEFAULT false NOT NULL,
	"provenance_source_repo" text,
	"provenance_builder" text,
	"provenance_commit" text,
	"provenance_build_type" text,
	"has_rekor_entry" boolean DEFAULT false NOT NULL,
	"rekor_entry_count" integer,
	"rekor_log_index" integer,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aws_integrations" ADD CONSTRAINT "aws_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aws_raw_events" ADD CONSTRAINT "aws_raw_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aws_raw_events" ADD CONSTRAINT "aws_raw_events_integration_id_aws_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."aws_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_block_cursors" ADD CONSTRAINT "chain_block_cursors_network_id_chain_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."chain_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_contracts" ADD CONSTRAINT "chain_contracts_network_id_chain_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."chain_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_org_contracts" ADD CONSTRAINT "chain_org_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_org_contracts" ADD CONSTRAINT "chain_org_contracts_contract_id_chain_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."chain_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_org_contracts" ADD CONSTRAINT "chain_org_contracts_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_org_rpc_configs" ADD CONSTRAINT "chain_org_rpc_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_org_rpc_configs" ADD CONSTRAINT "chain_org_rpc_configs_network_id_chain_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."chain_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_state_snapshots" ADD CONSTRAINT "chain_state_snapshots_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_state_snapshots" ADD CONSTRAINT "chain_state_snapshots_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_state_snapshots" ADD CONSTRAINT "chain_state_snapshots_network_id_chain_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."chain_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_detection_id_detections_id_fk" FOREIGN KEY ("detection_id") REFERENCES "public"."detections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correlation_rules" ADD CONSTRAINT "correlation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correlation_rules" ADD CONSTRAINT "correlation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_cdn_origin_records" ADD CONSTRAINT "infra_cdn_origin_records_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_cdn_provider_configs" ADD CONSTRAINT "infra_cdn_provider_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_certificates" ADD CONSTRAINT "infra_certificates_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_ct_log_entries" ADD CONSTRAINT "infra_ct_log_entries_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_dns_changes" ADD CONSTRAINT "infra_dns_changes_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_dns_health_checks" ADD CONSTRAINT "infra_dns_health_checks_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_dns_records" ADD CONSTRAINT "infra_dns_records_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_finding_suppressions" ADD CONSTRAINT "infra_finding_suppressions_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_hosts" ADD CONSTRAINT "infra_hosts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_hosts" ADD CONSTRAINT "infra_hosts_parent_id_infra_hosts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_http_header_checks" ADD CONSTRAINT "infra_http_header_checks_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_reachability_checks" ADD CONSTRAINT "infra_reachability_checks_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_scan_events" ADD CONSTRAINT "infra_scan_events_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_scan_schedules" ADD CONSTRAINT "infra_scan_schedules_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_scan_step_results" ADD CONSTRAINT "infra_scan_step_results_scan_event_id_infra_scan_events_id_fk" FOREIGN KEY ("scan_event_id") REFERENCES "public"."infra_scan_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_score_history" ADD CONSTRAINT "infra_score_history_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_snapshots" ADD CONSTRAINT "infra_snapshots_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_tls_analyses" ADD CONSTRAINT "infra_tls_analyses_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_whois_changes" ADD CONSTRAINT "infra_whois_changes_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "infra_whois_records" ADD CONSTRAINT "infra_whois_records_host_id_infra_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."infra_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_artifact_events" ADD CONSTRAINT "rc_artifact_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_artifact_events" ADD CONSTRAINT "rc_artifact_events_artifact_id_rc_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."rc_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_artifact_events" ADD CONSTRAINT "rc_artifact_events_version_id_rc_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."rc_artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_artifact_versions" ADD CONSTRAINT "rc_artifact_versions_artifact_id_rc_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."rc_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_artifacts" ADD CONSTRAINT "rc_artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_attributions" ADD CONSTRAINT "rc_attributions_artifact_event_id_rc_artifact_events_id_fk" FOREIGN KEY ("artifact_event_id") REFERENCES "public"."rc_artifact_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_attributions" ADD CONSTRAINT "rc_attributions_artifact_id_rc_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."rc_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_ci_notifications" ADD CONSTRAINT "rc_ci_notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_ci_notifications" ADD CONSTRAINT "rc_ci_notifications_matched_artifact_event_id_rc_artifact_events_id_fk" FOREIGN KEY ("matched_artifact_event_id") REFERENCES "public"."rc_artifact_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_verifications" ADD CONSTRAINT "rc_verifications_artifact_id_rc_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."rc_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rc_verifications" ADD CONSTRAINT "rc_verifications_version_id_rc_artifact_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."rc_artifact_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aws_integration_org" ON "aws_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_aws_integration_account" ON "aws_integrations" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_aws_raw_org" ON "aws_raw_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_aws_raw_integration" ON "aws_raw_events" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "idx_aws_raw_received_at" ON "aws_raw_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_aws_raw_event_name" ON "aws_raw_events" USING btree ("event_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_aws_raw_cloudtrail_id" ON "aws_raw_events" USING btree ("integration_id","cloudtrail_event_id");--> statement-breakpoint
CREATE INDEX "idx_chain_container_metrics_name_time" ON "chain_container_metrics" USING btree ("container_name","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_chain_container_metrics_time" ON "chain_container_metrics" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chain_contracts_network_address" ON "chain_contracts" USING btree ("network_id","address");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chain_org_contracts_org_contract" ON "chain_org_contracts" USING btree ("org_id","contract_id");--> statement-breakpoint
CREATE INDEX "idx_chain_org_contracts_org" ON "chain_org_contracts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chain_org_rpc_configs_org_network" ON "chain_org_rpc_configs" USING btree ("org_id","network_id");--> statement-breakpoint
CREATE INDEX "idx_chain_org_rpc_configs_org" ON "chain_org_rpc_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_chain_rpc_usage_org_bucket" ON "chain_rpc_usage_hourly" USING btree ("org_id","bucket");--> statement-breakpoint
CREATE INDEX "idx_chain_rpc_usage_bucket" ON "chain_rpc_usage_hourly" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "idx_chain_snapshots_rule_time" ON "chain_state_snapshots" USING btree ("rule_id","polled_at");--> statement-breakpoint
CREATE INDEX "idx_chain_snapshots_address_slot" ON "chain_state_snapshots" USING btree ("address","slot") WHERE slot IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_chain_snapshots_triggered" ON "chain_state_snapshots" USING btree ("detection_id","polled_at") WHERE triggered = true;--> statement-breakpoint
CREATE INDEX "idx_alerts_org" ON "alerts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_detection" ON "alerts" USING btree ("detection_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_created_at" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alerts_event_detection_rule" ON "alerts" USING btree ("event_id","detection_id","rule_id") WHERE event_id IS NOT NULL AND detection_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alerts_event_correlation" ON "alerts" USING btree ("event_id",(trigger_data->>'correlationRuleId')) WHERE trigger_type = 'correlated' AND event_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_org" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_org" ON "audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_user" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_detections_org" ON "detections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_detections_module" ON "detections" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "idx_detections_status" ON "detections" USING btree ("status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_detections_created_by" ON "detections" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_events_org_module" ON "events" USING btree ("org_id","module_id");--> statement-breakpoint
CREATE INDEX "idx_events_type" ON "events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_events_external" ON "events" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_events_received_at" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_notification_channels_org" ON "notification_channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_notif_deliveries_alert" ON "notification_deliveries" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "idx_notif_deliveries_status" ON "notification_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notif_deliveries_created" ON "notification_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_rules_detection" ON "rules" USING btree ("detection_id");--> statement-breakpoint
CREATE INDEX "idx_rules_org" ON "rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_rules_org_module" ON "rules" USING btree ("org_id","module_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_rules_module_type_active" ON "rules" USING btree ("module_id","rule_type") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_sessions_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_org_id" ON "sessions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_org" ON "slack_installations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_slack_installations_installed_by" ON "slack_installations" USING btree ("installed_by");--> statement-breakpoint
CREATE INDEX "idx_correlation_rules_org" ON "correlation_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_correlation_rules_status" ON "correlation_rules" USING btree ("status") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_gh_install_org" ON "github_installations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gh_repo" ON "github_repositories" USING btree ("installation_id","repo_id");--> statement-breakpoint
CREATE INDEX "idx_gh_repo_org" ON "github_repositories" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_cdn_origin_host_type_value" ON "infra_cdn_origin_records" USING btree ("host_id","record_type","record_value");--> statement-breakpoint
CREATE INDEX "idx_infra_cdn_origin_host" ON "infra_cdn_origin_records" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_cdn_provider_pattern" ON "infra_cdn_provider_configs" USING btree ("org_id","provider","host_pattern");--> statement-breakpoint
CREATE INDEX "idx_infra_cdn_provider_org" ON "infra_cdn_provider_configs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_certs_host_fingerprint" ON "infra_certificates" USING btree ("host_id","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_infra_certs_host_expiry" ON "infra_certificates" USING btree ("host_id","not_after");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_ct_host_crtsh" ON "infra_ct_log_entries" USING btree ("host_id","crt_sh_id");--> statement-breakpoint
CREATE INDEX "idx_infra_ct_host" ON "infra_ct_log_entries" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_dns_changes_host_detected" ON "infra_dns_changes" USING btree ("host_id","detected_at");--> statement-breakpoint
CREATE INDEX "idx_infra_dns_health_host" ON "infra_dns_health_checks" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_dns_records_host" ON "infra_dns_records" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_suppression" ON "infra_finding_suppressions" USING btree ("host_id","category","issue");--> statement-breakpoint
CREATE INDEX "idx_infra_suppressions_host" ON "infra_finding_suppressions" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_hosts_org_hostname" ON "infra_hosts" USING btree ("org_id","hostname");--> statement-breakpoint
CREATE INDEX "idx_infra_hosts_org_parent" ON "infra_hosts" USING btree ("org_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_infra_hosts_org_root" ON "infra_hosts" USING btree ("org_id","is_root");--> statement-breakpoint
CREATE INDEX "idx_infra_http_headers_host" ON "infra_http_header_checks" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_reachability_host" ON "infra_reachability_checks" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_reachability_checked" ON "infra_reachability_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "idx_infra_scan_events_host_started" ON "infra_scan_events" USING btree ("host_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_schedule_host" ON "infra_scan_schedules" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_infra_step_per_scan" ON "infra_scan_step_results" USING btree ("scan_event_id","step_type");--> statement-breakpoint
CREATE INDEX "idx_infra_step_results_event" ON "infra_scan_step_results" USING btree ("scan_event_id");--> statement-breakpoint
CREATE INDEX "idx_infra_score_host_recorded" ON "infra_score_history" USING btree ("host_id","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_infra_snapshots_host" ON "infra_snapshots" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_tls_host" ON "infra_tls_analyses" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_whois_changes_host" ON "infra_whois_changes" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_infra_whois_host" ON "infra_whois_records" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "idx_rc_events_artifact" ON "rc_artifact_events" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_rc_events_event" ON "rc_artifact_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_rc_events_type" ON "rc_artifact_events" USING btree ("artifact_event_type");--> statement-breakpoint
CREATE INDEX "idx_rc_events_created" ON "rc_artifact_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rc_version_artifact_version" ON "rc_artifact_versions" USING btree ("artifact_id","version");--> statement-breakpoint
CREATE INDEX "idx_rc_versions_artifact" ON "rc_artifact_versions" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_rc_versions_status" ON "rc_artifact_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rc_artifact_org_name_registry" ON "rc_artifacts" USING btree ("org_id","name","registry");--> statement-breakpoint
CREATE INDEX "idx_rc_artifacts_org" ON "rc_artifacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_rc_artifacts_type" ON "rc_artifacts" USING btree ("artifact_type");--> statement-breakpoint
CREATE INDEX "idx_rc_artifacts_registry" ON "rc_artifacts" USING btree ("registry");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rc_attribution_event" ON "rc_attributions" USING btree ("artifact_event_id");--> statement-breakpoint
CREATE INDEX "idx_rc_attributions_artifact" ON "rc_attributions" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_rc_attributions_status" ON "rc_attributions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_rc_ci_notif_org" ON "rc_ci_notifications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_rc_ci_notif_artifact" ON "rc_ci_notifications" USING btree ("artifact_name","version");--> statement-breakpoint
CREATE INDEX "idx_rc_ci_notif_digest" ON "rc_ci_notifications" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "idx_rc_ci_notif_unmatched" ON "rc_ci_notifications" USING btree ("artifact_name","version","digest") WHERE matched_artifact_event_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_rc_verifications_artifact" ON "rc_verifications" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_rc_verifications_version" ON "rc_verifications" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "idx_rc_verifications_digest" ON "rc_verifications" USING btree ("digest");