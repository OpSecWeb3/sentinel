-- Add plaintext user_id and org_id columns to sessions table for indexed
-- deletion lookups. Previously, deleting sessions by user or org required a
-- full table scan with per-row decryption in application code (O(n) on total
-- sessions). These columns are nullable for backward compatibility with
-- existing rows; new sessions populate them at creation time.

ALTER TABLE "sessions" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "org_id" uuid;
--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_sessions_org_id" ON "sessions" USING btree ("org_id");
