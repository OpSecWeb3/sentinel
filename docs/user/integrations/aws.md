# AWS CloudTrail Integration

This guide explains how to connect AWS CloudTrail to Sentinel so that Sentinel
can ingest and analyze API activity across your AWS accounts.

## Architecture overview

Sentinel reads CloudTrail events from an Amazon SQS queue. The recommended
data flow is:

```
CloudTrail --> S3 bucket --> S3 event notification --> SQS queue --> Sentinel
```

Sentinel polls the SQS queue on a configurable interval (default: 60 seconds)
and processes each CloudTrail event through its detection engine.

## Prerequisites

- A Sentinel account with the **Admin** role in your organization.
- An AWS account with CloudTrail enabled.
- An SQS queue that receives CloudTrail event notifications.
- Either an IAM role (recommended) or IAM access keys that Sentinel can use to
  read from the SQS queue.

## IAM role setup (recommended)

Cross-account IAM role assumption is the recommended authentication method.
Sentinel assumes the role to read from SQS without storing long-lived
credentials.

### Step 1: Create the IAM policy

Create a policy named `SentinelCloudTrailRead` with the following permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSQS",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:<region>:<account-id>:<queue-name>"
    },
    {
      "Sid": "ReadS3Objects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::<cloudtrail-bucket-name>/AWSLogs/*"
    }
  ]
}
```

Replace `<region>`, `<account-id>`, `<queue-name>`, and
`<cloudtrail-bucket-name>` with your actual values.

### Step 2: Create the IAM role

1. Open the IAM console and create a new role.
2. Select **Another AWS account** as the trusted entity.
3. Enter the Sentinel AWS account ID (provided by your Sentinel
   administrator).
4. Enable **Require external ID** and enter a unique external ID. Record this
   value; you will enter it in Sentinel.
5. Attach the `SentinelCloudTrailRead` policy.
6. Name the role `SentinelRole` (or your preferred name).
7. Copy the role ARN (for example,
   `arn:aws:iam::123456789012:role/SentinelRole`).

### Step 3: Register the role in Sentinel

1. In the Sentinel web console, navigate to **AWS > Integrations**.
2. Click **[+ add]**.
3. Enter a name for the integration (for example, "Production account").
4. Enter the 12-digit **AWS Account ID**.
5. Paste the **Role ARN**.
6. Enter the **External ID** you configured in Step 2.
7. Enter the **SQS Queue URL**.
8. Click **[create]**.

Sentinel immediately triggers an initial SQS poll.

## IAM access key setup (alternative)

If cross-account role assumption is not possible, you can provide static IAM
credentials instead.

1. Create an IAM user with the `SentinelCloudTrailRead` policy attached.
2. Generate an access key pair for the user.
3. In the Sentinel integration form, enter the **Access Key ID** and **Secret
   Access Key** instead of a Role ARN.

Sentinel encrypts credentials at rest. However, IAM roles are preferred because
they use temporary credentials and do not require key rotation.

## SQS queue configuration

### Creating the SQS queue

1. Open the SQS console and create a **Standard** queue (FIFO is not
   required).
2. Set the **Visibility Timeout** to at least 120 seconds (Sentinel may need
   time to process large batches).
3. Set the **Message Retention Period** to at least 4 days to buffer events
   during maintenance windows.
4. Enable **Server-Side Encryption** using an AWS-managed key or a custom
   KMS key.

### Connecting CloudTrail to SQS

1. Open the CloudTrail console and select your trail.
2. Under **S3 bucket**, enable **SNS notification delivery** or configure an
   **S3 event notification** on the bucket to publish to your SQS queue.
3. Alternatively, configure an EventBridge rule to forward CloudTrail events
   to the SQS queue.

### SQS access policy

Add a policy statement that allows S3 (or SNS/EventBridge) to send messages:

```json
{
  "Sid": "AllowCloudTrailDelivery",
  "Effect": "Allow",
  "Principal": { "Service": "s3.amazonaws.com" },
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:<region>:<account-id>:<queue-name>",
  "Condition": {
    "ArnLike": {
      "aws:SourceArn": "arn:aws:s3:::<cloudtrail-bucket-name>"
    }
  }
}
```

## AWS Organizations multi-account setup

Sentinel supports ingesting CloudTrail events from all accounts in an AWS
Organization through a single integration.

### Step 1: Enable organization trail

1. Open the CloudTrail console in the **management account**.
2. Create or update a trail with **Enable for all accounts in my
   organization** checked.
3. Configure the trail to deliver to a central S3 bucket in the management
   account.

### Step 2: Create a centralized SQS queue

Create an SQS queue in the management account. Configure the CloudTrail S3
bucket to send event notifications to this queue.

### Step 3: Register as an organization integration

1. In the Sentinel integration form, toggle **AWS Organizations** on.
2. Enter the **Management Account ID** (12 digits).
3. Optionally enter the **AWS Organization ID** (format: `o-xxxxxxxxxx`).
4. Enter the **SQS Queue URL** for the centralized queue.
5. Configure the IAM role in the management account.
6. Click **[create]**.

Sentinel automatically tracks which member account generated each event. The
**Connected Accounts** column on the integrations page shows all account IDs
seen in ingested events.

## What CloudTrail events Sentinel monitors

Sentinel ingests all CloudTrail management events delivered to the SQS queue.
Each event includes:

- **Event name** -- the AWS API action (for example, `CreateUser`,
  `RunInstances`).
- **Event source** -- the AWS service (for example, `iam.amazonaws.com`).
- **Principal ID** -- who performed the action.
- **User ARN** -- the full ARN of the caller.
- **Source IP** -- where the request originated.
- **AWS Region** -- where the action occurred.
- **Error code** -- present if the API call failed (for example,
  `AccessDenied`).
- **Resources** -- the AWS resources involved in the action.

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

The table below lists every IAM permission Sentinel needs, organized by
purpose.

| Permission | Resource | Purpose |
|---|---|---|
| `sqs:ReceiveMessage` | SQS queue ARN | Read CloudTrail event notifications |
| `sqs:DeleteMessage` | SQS queue ARN | Acknowledge processed messages |
| `sqs:GetQueueAttributes` | SQS queue ARN | Check queue depth and configuration |
| `s3:GetObject` | S3 bucket ARN (`/AWSLogs/*`) | Read CloudTrail log files |

If you use a customer-managed KMS key for SQS or S3 encryption, also grant:

| Permission | Resource | Purpose |
|---|---|---|
| `kms:Decrypt` | KMS key ARN | Decrypt SQS messages and S3 objects |

## Managing integrations

### Viewing integration status

Navigate to **AWS > Integrations**. Each integration shows:

- **Status** -- `active`, `error`, or `disabled`.
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

### Deleting an integration

Click **[delete]** to permanently remove the integration and all associated
raw events. When you delete the last active integration, Sentinel automatically
pauses all AWS detection rules for your organization.

### Updating configuration

Use the PATCH endpoint (or edit from the API) to update the SQS queue URL,
regions, poll interval, or credentials without deleting and recreating the
integration. Changes take effect immediately; Sentinel triggers a new poll
after each configuration update.

## Troubleshooting

### "No SQS queue URL configured" when triggering a manual poll

The integration was created without an SQS queue URL. Update the integration
to add the queue URL, then retry.

### Integration shows "error" status

Check the **Error message** field on the integrations page. Common causes:

- **Access denied** -- the IAM role or access keys lack the required SQS
  permissions. Review the permissions reference above.
- **Queue does not exist** -- the SQS queue was deleted or the URL is
  incorrect. Update the integration with the correct URL.
- **Region mismatch** -- the SQS region in Sentinel does not match the actual
  queue region.

### No events appearing after setup

1. Verify CloudTrail is delivering logs to the S3 bucket (check the bucket
   contents).
2. Verify the S3 bucket is sending event notifications to the SQS queue
   (check the SQS console for message count).
3. Trigger a manual poll in Sentinel and check the worker logs for errors.
4. Confirm the IAM permissions are correct by testing with the AWS CLI:
   `aws sqs receive-message --queue-url <url>`.

### Poll interval configuration

The default poll interval is 60 seconds. You can set it to any value between
30 and 3,600 seconds. Shorter intervals provide faster detection but increase
SQS API costs. For most deployments, 60 seconds provides a good balance
between latency and cost.
