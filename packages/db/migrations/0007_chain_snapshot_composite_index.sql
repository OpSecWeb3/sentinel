-- Add composite index on (rule_id, polled_at) for chain_state_snapshots.
-- Replaces the single-column rule_id index for all window/previous-value
-- queries which ORDER BY polled_at DESC — without this index those queries
-- do a full table scan per poll invocation.
CREATE INDEX IF NOT EXISTS idx_chain_snapshots_rule_time
  ON chain_state_snapshots (rule_id, polled_at DESC);

-- The old single-column index is now redundant (covered by the composite).
DROP INDEX IF EXISTS idx_chain_snapshots_rule;
