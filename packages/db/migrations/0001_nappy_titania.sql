ALTER TABLE "slack_installations" DROP CONSTRAINT "slack_installations_installed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT '["api:read"]'::jsonb;--> statement-breakpoint
ALTER TABLE "slack_installations" ALTER COLUMN "installed_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;