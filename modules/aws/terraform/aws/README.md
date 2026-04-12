# Sentinel AWS Integration — Terraform Setup

This Terraform module provisions the AWS-side resources required to connect your AWS account to Sentinel for CloudTrail event monitoring.

## What it creates

| Resource | Purpose |
|---|---|
| **SQS Queue** | Sentinel polls this queue for events |
| **SQS Dead-Letter Queue** | Captures messages that fail processing (monitor for issues) |
| **IAM Role** | Cross-account role that Sentinel assumes — least-privilege SQS read-only |
| **KMS Key** (optional) | Customer-managed encryption for queue messages at rest |
| **EventBridge Rule** (optional) | Routes CloudTrail management events and sign-in events to the queue |
| **EventBridge Rule — us-east-1** (auto) | Forwards global events (IAM, STS, sign-in) to the primary region |
| **EventBridge Rule** (optional) | Routes EC2 Spot interruption warnings to the queue |
| **SNS Subscription** (optional) | Subscribes the queue to an existing CloudTrail SNS topic |

## Prerequisites

- Terraform >= 1.5
- AWS CLI configured with credentials for the target account
- Your Sentinel account ID (provided by your Sentinel admin)
- If deploying outside us-east-1, your Terraform config must define an `aws.us_east_1` provider alias (see Quick start)

## Quick start

### Step 1 — Start the integration in Sentinel

1. Open Sentinel and go to **AWS Integrations > New Integration**
2. Enter your integration name and AWS account ID
3. Sentinel generates a unique **external ID** — copy it

### Step 2 — Copy the external ID and run Terraform

```bash
cd aws

# Configure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars:
#   - Set ca_sentinel_account_id
#   - Paste the external_id from Step 1
```

If your primary region is **not** us-east-1, add a provider alias so global events (IAM, STS, console sign-in) are forwarded automatically:

```hcl
# providers.tf
provider "aws" {
  region = "eu-west-1"  # your primary region
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
```

If your primary region **is** us-east-1, the alias is still required but no forwarding resources are created:

```hcl
provider "aws" {
  region = "us-east-1"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
```

```bash
# Deploy
terraform init
terraform plan
terraform apply
```

### Step 3 — Paste Terraform outputs into Sentinel

```bash
terraform output
```

Copy the `role_arn`, `sqs_queue_url`, and `sqs_region` values back into the Sentinel integration setup screen, then click **Finalize** to activate the integration.

You can also use the JSON config output with the API:

```bash
curl -X PATCH https://your-ca_sentinel/api/modules/aws/integrations/YOUR_INTEGRATION_ID \
  -H "Cookie: $SESSION" \
  -H "Content-Type: application/json" \
  -d "$(terraform output -json ca_sentinel_integration_config | jq '. + {name: "production"}')"
```

## Event delivery patterns

### Pattern A: EventBridge (single account)

```
CloudTrail ──> EventBridge Rule ──> SQS Queue ──> Sentinel
```

Set `enable_eventbridge_rule = true` (default). This captures management events and console sign-in events in the primary region. Customize the pattern with `eventbridge_event_pattern`.

**Important:** EventBridge only sees CloudTrail events from the account the rule is deployed in. For AWS Organizations, EventBridge in the management account will **not** see member account events — use Pattern B or C instead.

**Global events:** IAM, STS, and console sign-in events only appear in us-east-1. When your primary region is different, the module automatically deploys a second EventBridge rule in us-east-1 that forwards these events to the primary region's event bus (bus-to-bus), where they're routed to the SQS queue. This is controlled by `enable_global_event_forwarding` (default: `true`).

### Pattern B: SNS (required for org-wide coverage)

```
CloudTrail ──> S3 ──> SNS Topic ──> SQS Queue ──> Sentinel
```

Set `enable_eventbridge_rule = false` and provide `cloudtrail_sns_topic_arn`. The org trail writes logs from **all** member accounts to S3, and S3 notifications go to SNS for every log file — giving you full org-wide coverage through a single queue.

Latency is 5–15 minutes (CloudTrail batches S3 writes) vs 1–2 minutes with EventBridge.

### Pattern C: Hybrid (recommended for Organizations)

```
Management account events:  CloudTrail ──> EventBridge ──> SQS (1-2 min latency)
All member account events:  CloudTrail ──> S3 ──> SNS ──> SQS (5-15 min latency)
```

Enable **both** EventBridge and SNS to get fast detection for management account activity (root logins, IAM changes, CloudTrail tampering) while still covering all member accounts via SNS. Sentinel deduplicates by `cloudTrailEventId`, so management account events won't double-count.

```hcl
enable_eventbridge_rule  = true
cloudtrail_sns_topic_arn = "arn:aws:sns:us-east-1:222222222222:org-cloudtrail"
```

## Multi-account setup (AWS Organizations)

**EventBridge alone is not sufficient for org-wide coverage.** EventBridge in the management account only sees that account's events. You must use SNS (Pattern B) or the hybrid approach (Pattern C) to capture member account events.

### Recommended: Hybrid approach

```hcl
# In the management account
module "ca_sentinel" {
  source = "./aws"

  ca_sentinel_account_id   = "111111111111"
  external_id              = "ca_sentinel:your-org-id:abc123..."  # from Sentinel UI
  name_prefix              = "ca-sentinel-org"

  # Fast path for management account (1-2 min)
  enable_eventbridge_rule  = true

  # Full org coverage via SNS (5-15 min)
  cloudtrail_sns_topic_arn = "arn:aws:sns:us-east-1:222222222222:org-cloudtrail"
}
```

### SNS-only (simpler, slightly higher latency)

```hcl
module "ca_sentinel" {
  source = "./aws"

  ca_sentinel_account_id   = "111111111111"
  external_id              = "ca_sentinel:your-org-id:abc123..."  # from Sentinel UI
  name_prefix              = "ca-sentinel-org"
  enable_eventbridge_rule  = false
  cloudtrail_sns_topic_arn = "arn:aws:sns:us-east-1:222222222222:org-cloudtrail"
}
```

### Setting up the SNS topic for org trails

1. Open the **CloudTrail console** in the management account
2. Select your org trail
3. Enable **SNS notification delivery** and create or select a topic
4. The trail will publish a notification to SNS for every log file written to S3 (covering all member accounts)

For per-account monitoring without Organizations, run this module once in each account with a unique `name_prefix`.

## External ID rotation

If you rotate the external ID in Sentinel (via the **Rotate External ID** button), the integration enters a `needs_update` state. You must update the `external_id` in your `terraform.tfvars` with the new value and run `terraform apply` to update the IAM trust policy, then acknowledge the rotation in Sentinel.

## Security considerations

- **Least privilege**: the IAM role only has `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`, `sqs:GetQueueUrl`, and optionally `kms:Decrypt`. No write access to any AWS service.
- **External ID**: always required to prevent [confused deputy attacks](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html). Sentinel generates this value during setup — you cannot supply your own.
- **Encryption**: SQS messages are encrypted at rest using either a customer-managed KMS key (default) or AWS-managed SSE-SQS.
- **DLQ**: messages that fail processing 5 times are moved to the dead-letter queue with 14-day retention for forensic review.
- **Session duration**: the IAM role limits sessions to 1 hour. Sentinel automatically renews.

## Inputs

| Name | Description | Type | Default | Required |
|---|---|---|---|---|
| `ca_sentinel_account_id` | AWS account ID where Sentinel is hosted | `string` | — | yes |
| `external_id` | External ID from Sentinel's setup screen (must start with `ca_sentinel:`) | `string` | — | yes |
| `ca_sentinel_role_name` | IAM role name in the Sentinel account | `string` | `"CASentinelServiceRole"` | no |
| `name_prefix` | Prefix for resource names | `string` | `"ca_sentinel"` | no |
| `tags` | Additional tags for all resources | `map(string)` | `{}` | no |
| `enable_eventbridge_rule` | Create EventBridge rule for CloudTrail events | `bool` | `true` | no |
| `eventbridge_event_pattern` | Custom EventBridge event pattern (JSON) | `string` | `null` | no |
| `enable_spot_interruption_rule` | Create rule for EC2 Spot interruption warnings | `bool` | `false` | no |
| `enable_global_event_forwarding` | Forward IAM/STS/sign-in events from us-east-1 to primary region | `bool` | `true` | no |
| `sqs_message_retention_seconds` | Message retention period | `number` | `345600` (4d) | no |
| `sqs_visibility_timeout_seconds` | Message visibility timeout | `number` | `120` | no |
| `create_kms_key` | Create a dedicated KMS key for SQS | `bool` | `true` | no |
| `kms_key_arn` | ARN of an existing KMS key (when `create_kms_key = false`) | `string` | `null` | no |
| `cloudtrail_sns_topic_arn` | ARN of existing CloudTrail SNS topic | `string` | `null` | no |

## Outputs

| Name | Description |
|---|---|
| `sqs_queue_url` | SQS queue URL for Sentinel |
| `sqs_queue_arn` | SQS queue ARN |
| `sqs_region` | AWS region |
| `role_arn` | IAM role ARN for Sentinel |
| `account_id` | This AWS account ID |
| `kms_key_arn` | KMS key ARN (if created) |
| `dlq_url` | Dead-letter queue URL |
| `ca_sentinel_integration_config` | JSON config block for Sentinel's integration API |

## Destroying

```bash
terraform destroy
```

This removes all AWS resources created by this module. It does **not** affect your CloudTrail trail, S3 bucket, or SNS topic. After destroying, disable the integration in Sentinel to stop poll attempts.
