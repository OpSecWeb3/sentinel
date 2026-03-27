CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "alert_id" bigint NOT NULL REFERENCES "alerts"("id") ON DELETE CASCADE,
  "channel_id" text NOT NULL,
  "channel_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "status_code" integer,
  "response_time_ms" integer,
  "error" text,
  "attempt_count" integer NOT NULL DEFAULT 1,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_notif_deliveries_alert" ON "notification_deliveries" ("alert_id");
CREATE INDEX IF NOT EXISTS "idx_notif_deliveries_status" ON "notification_deliveries" ("status");
CREATE INDEX IF NOT EXISTS "idx_notif_deliveries_created" ON "notification_deliveries" ("created_at");
