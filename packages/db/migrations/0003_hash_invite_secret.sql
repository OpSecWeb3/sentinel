-- Harden org invite secrets at rest.
--
-- Previously invite_secret was stored in plaintext. This migration:
--   1. Adds invite_secret_hash  — SHA-256 hex digest for fast, safe DB lookup.
--   2. Adds invite_secret_encrypted — AES-256-GCM ciphertext (encrypted by app)
--      for admin retrieval. Populated for existing rows via the app's first
--      regenerate call; NULL here for rows migrated from plaintext because the
--      ENCRYPTION_KEY is not available in SQL.
--   3. Migrates existing rows: populate invite_secret_hash from the plaintext.
--   4. Drops the old plaintext invite_secret column.
--
-- After this migration:
--   • Admins retrieve the invite secret via GET /auth/org/invite-secret (decrypted by app).
--   • Joining uses the hash for the DB WHERE clause.
--   • Existing orgs will have invite_secret_encrypted = NULL until the admin calls
--     POST /auth/org/invite-secret/regenerate once to re-key with the new scheme.

ALTER TABLE "organizations" ADD COLUMN "invite_secret_hash" text;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "invite_secret_encrypted" text;
--> statement-breakpoint

-- Hash existing plaintext values (sha256 built-in, PG >= 11).
UPDATE "organizations"
SET "invite_secret_hash" = encode(sha256("invite_secret"::bytea), 'hex')
WHERE "invite_secret" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "organizations" DROP COLUMN "invite_secret";
