# AWS CloudTrail Integration

This guide explains how to connect AWS CloudTrail to Sentinel so that Sentinel
can ingest and analyze API activity across your AWS accounts.

## Architecture overview

Sentinel reads CloudTrail events from an Amazon SQS queue. Two event delivery
patterns are supported:

**Pattern A: EventBridge (recommended)**

```
CloudTrail --> EventBridge Rule --> SQS Queue --> Sentinel
```

**Pattern B: SNS (legacy / existing trails)**

```
CloudTrail --> S3 --> SNS Topic --> SQS Queue --> Sentinel
```

Sentinel polls the SQS queue on a configurable interval (default: 60 seconds)
and processes each event through its detection engine. Events land in a 7-day
raw buffer, and rule-matched events are promoted to the platform events table
(14-day retention).

> **Note:** Sentinel does not read CloudTrail logs from S3 directly. It only
> consumes events delivered to SQS via EventBridge or SNS.

## Prerequisites

- A Sentinel account with the **Admin** role in your organization.
- An AWS account with CloudTrail enabled (management events, all regions).
- Terraform >= 1.5 (if using the provided Terraform module), or manual AWS
  console/CLI access.

## Quick start with Terraform (recommended)

Sentinel ships a Terraform module that provisions all required AWS resources
automatically. This is the fastest and most reliable setup path.

### Step 1: Initialize the integration in Sentinel

1. Navigate to **AWS > Integrations > [+ add]**.
2. Enter a name for the integration (e.g. "Production account").
3. Enter the 12-digit **AWS Account ID**.
4. For AWS Organizations, toggle **Organization** on and optionally enter the
   **AWS Organization ID** (`o-xxxxxxxxxx`).
5. Click **Initialize**.
6. Copy the generated **External ID** (format: `ca_sentinel:<orgId>:<random>`).

### Step 2: Deploy Terraform

```bash
cd modules/aws/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
ca_sentinel_account_id  = "111111111111"                    # Sentinel's AWS account ID
external_id             = "ca_sentinel:your-org:abc123..."  # from Step 1
name_prefix             = "ca-sentinel"
enable_eventbridge_rule = true
create_kms_key          = true
```

Configure providers in `providers.tf` for your primary region:

```hcl
provider "aws" {
  region = "eu-west-2"  # your primary region
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
```

> If your primary region **is** us-east-1, you still need the alias — but no
> cross-region forwarding resources are created.

Deploy:

```bash
terraform init
terraform plan
terraform apply
```

### Step 3: Finalize in Sentinel

Copy the Terraform outputs into Sentinel's integration form:

```bash
terraform output
```

You need three values:
- **Role ARN** -- `role_arn`
- **SQS Queue URL** -- `sqs_queue_url`
- **SQS Region** -- `sqs_region`

Paste them into the Sentinel setup screen and click **Finalize**.

Or use the API shortcut:

```bash
curl -X PATCH https://your-sentinel/api/modules/aws/integrations/YOUR_ID \
  -H "Cookie: $SESSION" \
  -H "Content-Type: application/json" \
  -d "$(terraform output -json ca_sentinel_integration_config | jq '. + {name: "Production"}')"
```

Sentinel immediately triggers an initial SQS poll.

### What Terraform creates

| Resource | Purpose |
|---|---|
| SQS Queue | Sentinel polls this for events |
| SQS Dead-Letter Queue | Failed messages retained 14 days for forensic review |
| KMS Key + Alias (optional) | Encrypts queue messages at rest |
| EventBridge Rule (primary region) | Routes CloudTrail events to SQS |
| EventBridge Rule (us-east-1) | Forwards global events (IAM, STS, sign-in) to primary region |
| EventBridge Catch Rule (primary) | Routes forwarded global events to SQS |
| IAM Role | Cross-account role Sentinel assumes (SQS read-only) |
| IAM Forwarding Role | Allows EventBridge cross-region bus forwarding |

## AWS Organizations integration

Sentinel supports ingesting CloudTrail events from all accounts in an AWS
Organization through a single integration.

### How it works

An organization trail in the management account captures management events
from every member account and writes them to a central S3 bucket. Sentinel
automatically tracks which member account generated each event. The
**Connected Accounts** column on the integrations page shows all account IDs
seen in ingested events.

### Important: EventBridge alone is not enough

EventBridge in the management account only sees CloudTrail events from that
account -- it does **not** receive member account events, even with an org
trail enabled. To capture events from all member accounts, you must use SNS
(which receives S3 notifications for every log file, covering all accounts).

The recommended approach is the **hybrid pattern**: EventBridge for fast
management account detection (1--2 min latency) plus SNS for full org-wide
coverage (5--15 min latency). Sentinel deduplicates by `cloudTrailEventId`,
so management account events won't double-count.

### Setup with Terraform (recommended)

#### Step 1: Enable organization trail with SNS

1. Open the CloudTrail console in the **management account**.
2. Create or update a trail with **Enable for all accounts in my
   organization** checked.
3. Ensure the trail captures **Management events** in **All regions**.
4. Under the trail settings, enable **SNS notification delivery** and create
   or select an SNS topic. CloudTrail will publish a notification for every
   log file written to S3, covering all member accounts.

#### Step 2: Initialize in Sentinel

1. Navigate to **AWS > Integrations > [+ add]**.
2. Enter a name (e.g. "Production Org").
3. Enter the **Management Account ID** (12 digits).
4. Toggle **Organization** on.
5. Enter the **AWS Organization ID** (`o-xxxxxxxxxx`).
6. Click **Initialize** and copy the **External ID**.

#### Step 3: Deploy Terraform in the management account

**Hybrid approach (recommended):**

```hcl
ca_sentinel_account_id   = "111111111111"                        # Sentinel's AWS account
external_id              = "ca_sentinel:your-org-id:abc123..."   # from Step 2
name_prefix              = "ca-sentinel-org"

# Fast path for management account events (1-2 min latency)
enable_eventbridge_rule   = true

# Full org coverage via SNS (5-15 min latency for member accounts)
cloudtrail_sns_topic_arn  = "arn:aws:sns:us-east-1:222222222222:org-cloudtrail"
cloudtrail_s3_bucket_arn  = "arn:aws:s3:::my-org-trail-bucket"
```

**SNS-only (simpler, uniform latency):**

```hcl
ca_sentinel_account_id   = "111111111111"
external_id              = "ca_sentinel:your-org-id:abc123..."
name_prefix              = "ca-sentinel-org"
enable_eventbridge_rule   = false
cloudtrail_sns_topic_arn  = "arn:aws:sns:us-east-1:222222222222:org-cloudtrail"
cloudtrail_s3_bucket_arn  = "arn:aws:s3:::my-org-trail-bucket"
```

Deploy:

```bash
terraform init && terraform plan && terraform apply
```

#### Step 4: Finalize in Sentinel

Copy the outputs (`role_arn`, `sqs_queue_url`, `sqs_region`) into the Sentinel
integration form and click **Finalize**.

#### Step 5: Verify

1. Check the integration status shows **Active** on the integrations page.
2. Wait for the first poll cycle (default 60 seconds).
3. Navigate to **AWS > Events** -- you should see CloudTrail events from
   member accounts within 5--15 minutes (SNS path) or 1--2 minutes for
   management account events (EventBridge path).
4. The **Connected Accounts** column populates as events arrive from each
   member account.

### Latency comparison

| Path | Covers | Latency | How |
|---|---|---|---|
| EventBridge | Management account only | 1--2 min | CloudTrail emits directly to EventBridge |
| SNS | All accounts (org-wide) | 5--15 min | CloudTrail batches S3 writes, S3 notifies SNS |
| Hybrid (both) | All accounts | 1--2 min mgmt, 5--15 min members | Best of both; Sentinel deduplicates |

### Global event forwarding

IAM, STS, and console sign-in events only appear in us-east-1 regardless of
where the action was performed. When your primary region is different and
EventBridge is enabled, the Terraform module automatically deploys a second
EventBridge rule in us-east-1 that forwards these global events to the primary
region's event bus, where a catch rule routes them to the SQS queue.

This is enabled by default (`enable_global_event_forwarding = true`) and
requires no additional configuration. If your primary region is us-east-1,
no forwarding resources are created.

Note: global event forwarding only applies to the EventBridge path. The SNS
path already captures global events because the org trail writes all events
(including global ones) to S3 regardless of region.

## Manual setup (without Terraform)

If you cannot use Terraform, follow these steps to provision resources
manually.

### IAM role setup (recommended)

Cross-account IAM role assumption is the recommended authentication method.
Sentinel assumes the role to read from SQS without storing long-lived
credentials.

#### Step 1: Create the IAM role

1. Open the IAM console and create a new role.
2. Select **Another AWS account** as the trusted entity.
3. Enter the **Sentinel AWS account ID** (provided by your Sentinel
   administrator).
4. Enable **Require external ID** and paste the external ID from Sentinel's
   integration setup screen.
5. Name the role (e.g. `ca-sentinel-integration-role`).
6. Set **Maximum session duration** to 1 hour.

#### Step 2: Attach the SQS read policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SQSRead",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": "arn:aws:sqs:<region>:<account-id>:<queue-name>"
    }
  ]
}
```

If using a customer-managed KMS key for SQS encryption, also attach:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KMSDecrypt",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>"
    }
  ]
}
```

#### Step 3: Create the SQS queue

1. Create a **Standard** queue (FIFO is not required).
2. Set **Visibility Timeout** to at least 120 seconds.
3. Set **Message Retention Period** to at least 4 days.
4. Enable **Server-Side Encryption** (AWS-managed or custom KMS key).
5. Configure a **Dead-Letter Queue** with max receive count of 5.

#### Step 4: Configure event delivery

**EventBridge (recommended):**

Create an EventBridge rule with this pattern:

```json
{
  "source": ["aws.cloudtrail", "aws.signin", "aws.iam", "aws.ec2", "aws.s3",
             "aws.route53", "aws.ssm", "aws.secretsmanager", "aws.dynamodb", "aws.ecs"],
  "detail-type": ["AWS API Call via CloudTrail", "AWS Console Sign In via CloudTrail"],
  "detail": {
    "eventSource": [
      "iam.amazonaws.com",
      "sts.amazonaws.com",
      "signin.amazonaws.com",
      "cloudtrail.amazonaws.com",
      "ec2.amazonaws.com",
      "s3.amazonaws.com",
      "route53.amazonaws.com",
      "ssm.amazonaws.com",
      "secretsmanager.amazonaws.com",
      "dynamodb.amazonaws.com",
      "ecs.amazonaws.com"
    ]
  }
}
```

Set the target to your SQS queue. Add a queue policy allowing EventBridge to
send messages:

```json
{
  "Sid": "AllowEventBridge",
  "Effect": "Allow",
  "Principal": { "Service": "events.amazonaws.com" },
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:<region>:<account-id>:<queue-name>",
  "Condition": {
    "ArnLike": {
      "aws:SourceArn": "arn:aws:events:<region>:<account-id>:rule/<rule-name>"
    }
  }
}
```

**SNS (existing trails):**

If your CloudTrail trail already publishes to an SNS topic, subscribe the SQS
queue to that topic with **Raw message delivery** enabled.

#### Step 5: Register in Sentinel

1. Initialize the integration in Sentinel (see Quick start Step 1).
2. Paste the **Role ARN**, **SQS Queue URL**, and **SQS Region** into the
   finalization form.
3. Click **Finalize**.

### IAM access key setup (alternative)

If cross-account role assumption is not possible, you can provide static IAM
credentials instead.

1. Create an IAM user with the SQS read policy attached.
2. Generate an access key pair for the user.
3. In the Sentinel integration form, enter the **Access Key ID** and **Secret
   Access Key** instead of a Role ARN.

Sentinel encrypts credentials at rest. However, IAM roles are preferred because
they use temporary credentials and do not require key rotation.

## What CloudTrail events Sentinel monitors

Sentinel ingests all CloudTrail management events delivered to the SQS queue.
Each event includes:

- **Event name** -- the AWS API action (e.g. `CreateUser`, `RunInstances`).
- **Event source** -- the AWS service (e.g. `iam.amazonaws.com`).
- **Principal ID** -- who performed the action.
- **User ARN** -- the full ARN of the caller.
- **Source IP** -- where the request originated.
- **AWS Region** -- where the action occurred.
- **Error code** -- present if the API call failed (e.g. `AccessDenied`).
- **Resources** -- the AWS resources involved in the action.

Sentinel also ingests native EventBridge events when configured:

- **EC2 Spot Instance Interruption Warning**
- **EC2 Instance State-change Notification**
- **EC2 Spot Rebalance Recommendation**

Navigate to **AWS > Events** to browse raw CloudTrail events with filtering
by integration, event name, and time range.

## Available detection templates

Navigate to **AWS > Templates** to see the full list. Sentinel ships with
the following built-in templates:

### Identity and access

| Template | Severity | Description |
|---|---|---|
| Root Account Activity Monitor | Critical | Alerts when the root account is used for any API action. |
| Console Login Monitor | High | Alerts on console login failures and root account logins. |
| IAM User Changes | High | Alerts when IAM users are created or deleted, or access keys are generated. |
| IAM Privilege Escalation Detection | Critical | Alerts on policy attachments and inline policy modifications. |
| Federated Identity Role Assumption | High | Alerts when roles are assumed via web identity (OIDC) or SAML. |
| MFA Deactivation Alert | High | Alerts when an MFA device is deactivated. |

### Defense evasion

| Template | Severity | Description |
|---|---|---|
| CloudTrail Tampering | Critical | Alerts when logging is stopped, a trail is deleted, or event selectors are modified. |
| AWS Config Evasion | Critical | Alerts when the Config recorder is stopped or compliance rules are deleted. |

### Network and compute

| Template | Severity | Description |
|---|---|---|
| Security Group Open Ingress | High | Alerts when security group ingress rules are added. |
| EC2 SSH Key Pair Changes | High | Alerts when SSH key pairs are created or imported. |
| Unusual EC2 Instance Launch | Medium | Alerts on instance launches and attribute modifications. |
| Spot Instance Eviction Monitor | Medium | Alerts on spot instance interruption warnings. |

### Data and storage

| Template | Severity | Description |
|---|---|---|
| S3 Public Access Changes | Critical | Alerts when S3 bucket ACLs, policies, or public access blocks are modified. |
| KMS Key Deletion, Disable, or Grant | Critical | Alerts when encryption keys are disabled, scheduled for deletion, or grants are created. |
| Secrets Manager Access Monitor | High | Alerts on secret reads and deletions from Secrets Manager. |

### Reconnaissance

| Template | Severity | Description |
|---|---|---|
| Access Denied Monitor | Medium | Alerts on access denied errors that may indicate credential enumeration. |

### Comprehensive

| Template | Severity | Description |
|---|---|---|
| AWS Full Security Suite | Critical | Enables all tier-1 AWS security monitors in one detection. |

## Required IAM permissions reference

| Permission | Resource | Purpose |
|---|---|---|
| `sqs:ReceiveMessage` | SQS queue ARN | Read CloudTrail event notifications |
| `sqs:DeleteMessage` | SQS queue ARN | Acknowledge processed messages |
| `sqs:GetQueueAttributes` | SQS queue ARN | Check queue depth and configuration |
| `sqs:GetQueueUrl` | SQS queue ARN | Resolve queue URL |

If using the SNS pattern (org trail), also grant:

| Permission | Resource | Purpose |
|---|---|---|
| `s3:GetObject` | S3 bucket ARN (`/*`) | Download CloudTrail .json.gz log files |

If you use a customer-managed KMS key for SQS or S3 encryption, also grant:

| Permission | Resource | Purpose |
|---|---|---|
| `kms:Decrypt` | KMS key ARN | Decrypt SQS messages or S3 objects |

## Managing integrations

### Viewing integration status

Navigate to **AWS > Integrations**. Each integration shows:

- **Status** -- `active`, `error`, `setup`, `disabled`, or `needs_update`.
- **Last polled** -- when Sentinel last checked the SQS queue.
- **Auth method** -- `role` (IAM role) or `access-key` (static credentials).
- **Connected accounts** -- AWS account IDs seen in ingested events.
- **Error message** -- details if the integration is in an error state.

### Triggering a manual poll

Click **[poll]** next to an integration to immediately check the SQS queue.
This is useful for verifying that the connection works after initial setup.

### Disabling an integration

Click **[disable]** to pause polling without deleting the integration. Click
**[enable]** to resume.

### Rotating the external ID

Click **[rotate ID]** to regenerate the external ID. The integration enters
a `needs_update` status. Update the IAM trust policy in AWS with the new
external ID (or run `terraform apply` with the new value in `terraform.tfvars`),
then click **[acknowledge]** in Sentinel to resume polling.

### Deleting an integration

Click **[delete]** to permanently remove the integration and all associated
raw events. When you delete the last active integration, Sentinel automatically
pauses all AWS detection rules for your organization.

### Updating configuration

Click **[edit]** or use the PATCH API endpoint to update the SQS queue URL,
regions, poll interval, or credentials without deleting and recreating the
integration. Changes take effect immediately; Sentinel triggers a new poll
after each configuration update.

## Troubleshooting

### Integration stuck in "setup" status

The integration was initialized but not finalized. Complete Step 3 of the
setup process by entering the Role ARN, SQS Queue URL, and SQS Region.
Abandoned setup integrations are automatically cleaned up after 24 hours.

### Integration shows "error" status

Check the **Error message** field on the integrations page. Common causes:

- **Access denied** -- the IAM role lacks the required SQS permissions, or the
  external ID in the trust policy doesn't match. Review the permissions
  reference above.
- **Queue does not exist** -- the SQS queue was deleted or the URL is
  incorrect. Update the integration with the correct URL.
- **Region mismatch** -- the SQS region in Sentinel does not match the actual
  queue region.

### No events appearing after setup

1. Verify CloudTrail is enabled and logging management events.
2. Verify the EventBridge rule is matching events (check the rule's monitoring
   tab in the AWS console).
3. Check the SQS console for message count -- if zero, events aren't reaching
   the queue.
4. Trigger a manual poll in Sentinel and check the worker logs for errors.
5. Confirm the IAM permissions are correct by testing with the AWS CLI:
   `aws sqs receive-message --queue-url <url>`.

### Global events (IAM, STS, sign-in) not appearing

These events only emit in us-east-1. If your SQS queue is in a different
region, you need cross-region EventBridge forwarding. The Terraform module
handles this automatically. For manual setups, create an EventBridge rule in
us-east-1 that forwards matching events to your primary region's default
event bus.

### Poll interval configuration

The default poll interval is 60 seconds. You can set it to any value between
30 and 3,600 seconds. Shorter intervals provide faster detection but increase
SQS API costs. For most deployments, 60 seconds provides a good balance
between latency and cost.
