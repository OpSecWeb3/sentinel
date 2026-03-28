-- 0003: Fix AWS schema issues and add missing cascade on rules.org_id
-- - Convert poll_interval_seconds from text to integer
-- - Add FK constraint on aws_raw_events.org_id → organizations.id
-- - Add ON DELETE CASCADE to rules.org_id FK

-- 1. Convert poll_interval_seconds from text to integer
--    Drop the text default first — Postgres cannot auto-cast '60'::text to integer.
ALTER TABLE "aws_integrations"
  ALTER COLUMN "poll_interval_seconds" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "aws_integrations"
  ALTER COLUMN "poll_interval_seconds" TYPE integer USING "poll_interval_seconds"::integer;
--> statement-breakpoint
ALTER TABLE "aws_integrations"
  ALTER COLUMN "poll_interval_seconds" SET DEFAULT 60;

-- 2. Add FK on aws_raw_events.org_id with cascade
ALTER TABLE "aws_raw_events"
  ADD CONSTRAINT "aws_raw_events_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- 3. Replace rules.org_id FK to add cascade (drop old, add new)
ALTER TABLE "rules"
  DROP CONSTRAINT IF EXISTS "rules_org_id_organizations_id_fk";

ALTER TABLE "rules"
  ADD CONSTRAINT "rules_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
