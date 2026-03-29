ALTER TABLE "chain_state_snapshots" DROP CONSTRAINT "chain_state_snapshots_network_id_chain_networks_id_fk";
--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "org_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "detections" DROP CONSTRAINT "detections_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "correlation_rules" DROP CONSTRAINT "correlation_rules_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chain_state_snapshots" ADD CONSTRAINT "chain_state_snapshots_network_id_chain_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."chain_networks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detections" ADD CONSTRAINT "detections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correlation_rules" ADD CONSTRAINT "correlation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;