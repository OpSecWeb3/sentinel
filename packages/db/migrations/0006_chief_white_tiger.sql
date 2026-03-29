ALTER TABLE "rules" DROP CONSTRAINT "rules_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "aws_integrations" ALTER COLUMN "poll_interval_seconds" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "aws_integrations" ALTER COLUMN "poll_interval_seconds" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "aws_raw_events" ADD CONSTRAINT "aws_raw_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alerts_created_at" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_org" ON "audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_user" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_detections_created_by" ON "detections" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_events_received_at" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_notification_channels_org" ON "notification_channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_rules_org" ON "rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_org_id" ON "sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_slack_installations_installed_by" ON "slack_installations" USING btree ("installed_by");