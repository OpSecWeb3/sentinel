ALTER TABLE chain_contracts ADD COLUMN traits jsonb NOT NULL DEFAULT '[]'::jsonb;
