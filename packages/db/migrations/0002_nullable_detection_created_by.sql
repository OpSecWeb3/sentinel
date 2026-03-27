-- Allow system-generated detections (auto-rules) to have NULL created_by
ALTER TABLE "detections" ALTER COLUMN "created_by" DROP NOT NULL;
