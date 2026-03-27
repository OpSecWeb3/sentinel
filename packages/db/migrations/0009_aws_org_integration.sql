-- AWS Organizations integration support
-- Adds two columns to aws_integrations so a single integration can cover
-- all accounts in an AWS Organization via the management account's SQS queue.

ALTER TABLE aws_integrations
  ADD COLUMN is_org_integration boolean NOT NULL DEFAULT false;

ALTER TABLE aws_integrations
  ADD COLUMN aws_org_id text;
