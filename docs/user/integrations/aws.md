# AWS integration

This guide explains how to connect Sentinel to your AWS account to monitor CloudTrail events. Sentinel ingests CloudTrail events via SQS to detect unauthorized API calls, root account activity, console authentication failures, and arbitrary CloudTrail event patterns you define.

## What Sentinel monitors in AWS

Sentinel consumes events from AWS CloudTrail delivered to an SQS queue. The AWS module supports the following ingestion patterns:

- **CloudTrail via EventBridge to SQS**: The recommended delivery path. EventBridge delivers individual CloudTrail events directly to an SQS queue for real-time processing.
- **CloudTrail via SNS to SQS**: CloudTrail sends log file notifications to SNS, which forwards them to SQS.
- **Native EventBridge events**: Sentinel also processes native EventBridge events (such as EC2 Spot Instance Interruption Warnings) that are not CloudTrail events but follow the EventBridge event envelope format.

From these events, Sentinel provides the following built-in evaluators:

- **Event match**: Alerts on CloudTrail events matching configurable filters, including event name, event source, user type, principal ARN, error code, and AWS region.
- **Root activity**: Alerts whenever the AWS root account performs any API action, including failed attempts that may indicate credential testing.
- **Auth failure**: Alerts on console login failures, successful root console logins, and (optionally) console logins without MFA.
- **Spot eviction**: Alerts when EC2 Spot instances are interrupted, enabling rapid incident response for workloads running on Spot capacity.

## Prerequisites

- An AWS account with CloudTrail enabled at the organization or account level.
- An SQS queue that receives CloudTrail event notifications. See [Setting up CloudTrail delivery](#setting-up-cloudtrail-delivery) if you have not yet configured this.
- AWS credentials (IAM role or IAM user) with the permissions listed in [Step 2](#step-2-required-iam-permissions).
- The **admin** role in your Sentinel organization.

## Step 1: Create an IAM role or user for Sentinel

Create a dedicated IAM principal for Sentinel. Using an IAM role with an assumed-role trust policy is recommended for production environments.

### Creating an IAM role (recommended)

1. In the AWS IAM console, select **Roles** and click **Create role**.
2. Under **Trusted entity type**, select **AWS account**. Enter the account ID of the system where Sentinel is deployed, or select **This account** if Sentinel runs within the same AWS account.
3. If your Sentinel administrator has configured an external ID for cross-account access, provide it in the trust policy's `Condition` block. The external ID prevents confused deputy attacks.
4. Name the role, for example `SentinelMonitorRole`.
5. Attach the policy you create in Step 2.

### Creating an IAM user (alternative)

1. In the AWS IAM console, select **Users** and click **Add users**.
2. Name the user, for example `sentinel-monitor`.
3. Select **Access key - Programmatic access** as the credential type.
4. Attach the policy you create in Step 2.
5. Download the access key ID and secret access key. Store these securely; you cannot retrieve the secret key again after this step.

## Step 2: Required IAM permissions

Attach a policy with the following minimum permissions to the IAM principal you created:

| Service | Action | Purpose |
|---|---|---|
| SQS | `sqs:ReceiveMessage` | Receive CloudTrail event notifications from the queue |
| SQS | `sqs:DeleteMessage` | Delete messages after successful processing |
| SQS | `sqs:GetQueueAttributes` | Verify queue configuration at startup |
| SQS | `sqs:GetQueueUrl` | Resolve the queue URL from its name |

The following is a minimal IAM policy document. Replace `<region>`, `<account-id>`, and `<queue-name>` with your values:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SentinelSQSAccess",
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

> **Warning:** Do not grant Sentinel write permissions to CloudTrail, S3, or IAM. Sentinel is a read-only consumer. Granting unnecessary write permissions violates the principle of least privilege and creates risk if Sentinel's credentials are compromised.

## Step 3: Connect your AWS account in Sentinel

1. In Sentinel, navigate to **Settings** and select **AWS**.
2. Click **Add AWS Integration** and provide the following values:
   - **AWS Region**: The AWS region where your SQS queue resides, for example `us-east-1`.
   - **SQS Queue URL**: The full URL of the SQS queue, for example `https://sqs.us-east-1.amazonaws.com/123456789012/cloudtrail-sentinel`.
   - **Poll interval (seconds)**: The interval at which Sentinel polls the SQS queue. Default is 60 seconds. Lower intervals increase API costs; higher intervals increase alert latency.
3. Configure authentication using one of the following methods:
   - **IAM Role ARN**: Enter the full ARN of the IAM role you created in Step 1. Sentinel uses AWS STS `AssumeRole` to obtain temporary credentials. If an external ID is required, enter it in the **External ID** field.
   - **AWS Access Key ID and Secret Access Key**: Enter the credentials for the IAM user you created. Sentinel encrypts these credentials at rest.
   - **Instance profile**: If Sentinel runs on an EC2 instance or ECS task with an attached instance profile or task role, leave the credential fields blank. Sentinel falls back to the environment or instance profile credentials automatically.
4. Click **Save**.

> **Note:** If Sentinel is deployed in AWS, prefer attaching an IAM instance profile or task role rather than providing static access keys. Instance profiles rotate credentials automatically and eliminate the risk of key leakage.

## Organization-level monitoring

To monitor multiple AWS accounts from a single Sentinel organization, create a separate integration for each account's SQS queue. Each integration can use a different IAM role for cross-account access.

1. In Sentinel, navigate to **Settings** and select **AWS**.
2. Click **Add AWS Integration** for each additional account.
3. Provide the SQS queue URL and IAM role ARN for the target account.

Sentinel polls each integration independently on its configured interval. All events from all integrations are unified into the same event stream and evaluated against the same set of detections.

## How Sentinel polls SQS

Sentinel's AWS module uses a scheduled poll-sweep architecture:

1. A **poll sweep** job runs every 60 seconds. It identifies all active AWS integrations that are due for a poll (based on their configured poll interval and last poll time).
2. For each due integration, a dedicated **SQS poll** job is enqueued. This job receives up to 100 messages per run (10 batches of 10 messages).
3. Each SQS message is parsed as a CloudTrail event (or an SNS notification wrapping a CloudTrail event). Individual events are stored as raw records and promoted to the platform events table for rule evaluation.
4. Successfully processed messages are deleted from the SQS queue.
5. The integration's `lastPolledAt` timestamp is updated after each poll run.

If the SQS client cannot be constructed (for example, due to expired credentials), the integration's status is set to `error` with a diagnostic message. Fix the credential issue and the next poll sweep will automatically retry.

## Event types monitored

Sentinel normalizes CloudTrail events into the following event types:

| Event type | Description |
|---|---|
| `aws.cloudtrail.event_match` | General CloudTrail event matching configurable filters |
| `aws.cloudtrail.root_activity` | Any API action performed by the AWS root account |
| `aws.cloudtrail.auth_failure` | Console login failures and suspicious authentication events |
| `aws.ec2.spot_interruption` | EC2 Spot instance interruption warnings (via EventBridge) |

Each event record includes the full CloudTrail payload, the extracted principal identity (ARN, account ID, user type), the source IP address, user agent, and any error codes.

## Setting up CloudTrail delivery

If you have not already configured CloudTrail to deliver events to SQS, follow these steps.

### Option A: EventBridge to SQS (recommended)

1. In the Amazon EventBridge console, create a new rule.
2. Set the event pattern to match CloudTrail API calls. For example, to match all management events:
   ```json
   {
     "source": ["aws.cloudtrail"],
     "detail-type": ["AWS API Call via CloudTrail"]
   }
   ```
3. Set the target to your SQS queue.
4. Update the SQS queue's access policy to allow EventBridge to publish messages.

### Option B: SNS to SQS

1. In the Amazon SNS console, create a new topic, for example `cloudtrail-events`.
2. In the Amazon SQS console, create a new standard queue, for example `cloudtrail-sentinel`. Configure a dead-letter queue for failed deliveries.
3. Subscribe the SQS queue to the SNS topic.
4. In your CloudTrail trail settings, enable **SNS notification for every log file delivery** and select the SNS topic.
5. Update the SQS queue's access policy to allow the SNS topic to publish messages:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSNSPublish",
      "Effect": "Allow",
      "Principal": { "Service": "sns.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "<queue-arn>",
      "Condition": {
        "ArnEquals": { "aws:SourceArn": "<topic-arn>" }
      }
    }
  ]
}
```

## Testing the integration

To confirm that AWS events are flowing into Sentinel:

1. In the AWS IAM console, create a test IAM user named `sentinel-test-user` and immediately delete it. This generates two CloudTrail events: `CreateUser` and `DeleteUser`.
2. Wait 60 to 120 seconds for CloudTrail to deliver the events and for Sentinel to poll SQS.
3. Navigate to the **Alerts** page in Sentinel and filter by **Module: aws**.

> **Note:** If you have an `aws.event_match` detection configured to match `CreateUser` or `DeleteUser` events, you see alerts for the test actions. If you have not yet created any detections, create one using the AWS module. See [Custom Rules](../detections/custom-rules.md) for configuration options.

## Troubleshooting

### Integration status shows "error"

Check the error message displayed on the integration detail page. Common causes include:

- **Expired or invalid credentials**: Verify the IAM role ARN and external ID, or regenerate the IAM user access keys.
- **SQS queue URL is incorrect**: Confirm the queue URL and region match your SQS configuration.
- **IAM policy is missing permissions**: Ensure the attached policy includes `sqs:ReceiveMessage` and `sqs:DeleteMessage`.

### Events appear in SQS but not in Sentinel

- Verify the SQS message format. Sentinel expects either direct CloudTrail event JSON or an SNS notification envelope containing the event.
- Check the Sentinel worker logs for parsing errors related to `aws.sqs.poll` or `aws.event.process` jobs.

### High SQS message count (messages not being deleted)

If messages accumulate in the queue, Sentinel may be failing to process them. Check:

- Worker health and queue depth in your Sentinel deployment.
- Whether the SQS visibility timeout is too short. Set it to at least 30 seconds.
- Dead-letter queue for messages that repeatedly fail processing.
