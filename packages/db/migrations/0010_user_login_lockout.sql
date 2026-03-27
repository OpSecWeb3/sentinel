-- Add brute-force login protection columns to users table.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
