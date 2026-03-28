-- 0004: Add missing indexes on foreign key columns
-- These columns are used in WHERE clauses and JOINs but had no index,
-- causing full table scans as data grows.

CREATE INDEX IF NOT EXISTS "idx_detections_created_by"
  ON "detections" ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notification_channels_org"
  ON "notification_channels" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_org"
  ON "audit_log" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_user"
  ON "audit_log" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_installations_installed_by"
  ON "slack_installations" ("installed_by");
