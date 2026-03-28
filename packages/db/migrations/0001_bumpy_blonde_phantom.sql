-- P2: Add unique constraints to prevent duplicate alerts.
--
-- Note: these use plain CREATE INDEX (not CONCURRENTLY) because drizzle-kit
-- migrate wraps each file in a transaction, and CONCURRENTLY cannot run
-- inside a transaction. This is safe pre-production. Once the alerts table
-- holds significant production data, new index migrations should use
-- CONCURRENTLY and be applied outside of drizzle-kit (see migrations.md).

CREATE UNIQUE INDEX IF NOT EXISTS "uq_alerts_event_detection_rule"
  ON "alerts" USING btree ("event_id", "detection_id", "rule_id")
  WHERE event_id IS NOT NULL AND detection_id IS NOT NULL;
--> statement-breakpoint
-- Expression index: include correlationRuleId from trigger_data JSONB to
-- properly deduplicate correlated alerts per event per correlation rule.
-- Drizzle cannot generate expression indexes natively, so this uses raw SQL.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_alerts_event_correlation"
  ON "alerts" USING btree ("event_id", (trigger_data->>'correlationRuleId'))
  WHERE trigger_type = 'correlated' AND event_id IS NOT NULL;
