-- 0005: Add standalone org_id index on rules
--
-- rules.org_id: The existing idx_rules_org_module is a partial index
-- (WHERE status = 'active'), so queries filtering by org_id without that
-- condition — such as detection rule lookups and chain-analytics EXISTS
-- sub-selects — fall through to a full table scan.
--
-- Note: A standalone events.org_id index is NOT needed because the composite
-- idx_events_org_module(org_id, module_id) already covers org_id-only lookups
-- via its leftmost column.

CREATE INDEX IF NOT EXISTS "idx_rules_org"
  ON "rules" ("org_id");
