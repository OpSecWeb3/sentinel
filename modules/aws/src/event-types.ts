import type { EventTypeDefinition } from '@sentinel/shared/module';

export const eventTypes: EventTypeDefinition[] = [
  // ── IAM ─────────────────────────────────────────────────────────────
  {
    type: 'aws.iam.CreateUser',
    label: 'IAM user created',
    description: 'A new IAM user was created',
  },
  {
    type: 'aws.iam.DeleteUser',
    label: 'IAM user deleted',
    description: 'An IAM user was deleted',
  },
  {
    type: 'aws.iam.CreateAccessKey',
    label: 'IAM access key created',
    description: 'An access key was created for an IAM user',
  },
  {
    type: 'aws.iam.DeleteAccessKey',
    label: 'IAM access key deleted',
    description: 'An access key was deleted',
  },
  {
    type: 'aws.iam.AttachUserPolicy',
    label: 'Policy attached to user',
    description: 'A managed policy was attached directly to an IAM user',
  },
  {
    type: 'aws.iam.AttachRolePolicy',
    label: 'Policy attached to role',
    description: 'A managed policy was attached to an IAM role',
  },
  {
    type: 'aws.iam.CreateRole',
    label: 'IAM role created',
    description: 'A new IAM role was created',
  },
  {
    type: 'aws.iam.DeleteRole',
    label: 'IAM role deleted',
    description: 'An IAM role was deleted',
  },
  {
    type: 'aws.iam.UpdateAssumeRolePolicy',
    label: 'Role trust policy updated',
    description: 'The trust policy (assume role policy) of an IAM role was modified',
  },
  {
    type: 'aws.iam.PutUserPolicy',
    label: 'Inline policy set on user',
    description: 'An inline policy was added or updated on an IAM user',
  },
  {
    type: 'aws.iam.PutRolePolicy',
    label: 'Inline policy set on role',
    description: 'An inline policy was added or updated on an IAM role',
  },
  {
    type: 'aws.iam.AddUserToGroup',
    label: 'User added to IAM group',
    description: 'An IAM user was added to a group',
  },
  {
    type: 'aws.iam.CreateLoginProfile',
    label: 'IAM console login profile created',
    description: 'Console access was enabled for an IAM user',
  },
  {
    type: 'aws.iam.UpdateLoginProfile',
    label: 'IAM console password updated',
    description: 'The console password for an IAM user was changed',
  },
  {
    type: 'aws.iam.DeactivateMFADevice',
    label: 'MFA device deactivated',
    description: 'An MFA device was deactivated for an IAM user',
  },
  {
    type: 'aws.iam.AssumeRoleWithWebIdentity',
    label: 'Role assumed via web identity',
    description: 'A role was assumed using a web identity token (OIDC/OAuth — GitHub Actions, Google, etc.)',
  },
  {
    type: 'aws.iam.AssumeRoleWithSAML',
    label: 'Role assumed via SAML',
    description: 'A role was assumed via SAML federation (SSO provider)',
  },

  // ── Console / Auth ───────────────────────────────────────────────────
  {
    type: 'aws.signin.ConsoleLogin',
    label: 'Console login',
    description: 'A user signed in to the AWS Management Console',
  },

  // ── EC2 / Network ────────────────────────────────────────────────────
  {
    type: 'aws.ec2.AuthorizeSecurityGroupIngress',
    label: 'Security group ingress rule added',
    description: 'An inbound rule was added to a security group',
  },
  {
    type: 'aws.ec2.AuthorizeSecurityGroupEgress',
    label: 'Security group egress rule added',
    description: 'An outbound rule was added to a security group',
  },
  {
    type: 'aws.ec2.RevokeSecurityGroupIngress',
    label: 'Security group ingress rule removed',
    description: 'An inbound rule was removed from a security group',
  },
  {
    type: 'aws.ec2.CreateSecurityGroup',
    label: 'Security group created',
    description: 'A new security group was created',
  },
  {
    type: 'aws.ec2.TerminateInstances',
    label: 'EC2 instances terminated',
    description: 'One or more EC2 instances were terminated',
  },
  {
    type: 'aws.ec2.StopInstances',
    label: 'EC2 instances stopped',
    description: 'One or more EC2 instances were stopped',
  },
  {
    type: 'aws.ec2.RunInstances',
    label: 'EC2 instances launched',
    description: 'New EC2 instances were launched — unusual regions or instance types can indicate crypto mining or C2 infrastructure',
  },
  {
    type: 'aws.ec2.CreateKeyPair',
    label: 'EC2 key pair created',
    description: 'A new SSH key pair was created — grants SSH access to instances',
  },
  {
    type: 'aws.ec2.ImportKeyPair',
    label: 'EC2 key pair imported',
    description: 'An external SSH public key was imported — attacker may be establishing persistent SSH access',
  },
  {
    type: 'aws.ec2.ModifyInstanceAttribute',
    label: 'EC2 instance attribute modified',
    description: 'An instance attribute was changed — can disable monitoring, inject user-data scripts, or modify security groups',
  },
  {
    type: 'aws.ec2.SpotInstanceInterruption',
    label: 'Spot instance interrupted',
    description: 'AWS is reclaiming a spot instance — instance will be terminated within 2 minutes',
  },

  // ── S3 ───────────────────────────────────────────────────────────────
  {
    type: 'aws.s3.PutBucketAcl',
    label: 'S3 bucket ACL changed',
    description: 'The ACL of an S3 bucket was modified (potential public access)',
  },
  {
    type: 'aws.s3.GetBucketAcl',
    label: 'S3 bucket ACL read',
    description: 'The ACL of an S3 bucket was read — may be part of reconnaissance',
  },
  {
    type: 'aws.s3.PutBucketPolicy',
    label: 'S3 bucket policy changed',
    description: 'The resource policy of an S3 bucket was modified',
  },
  {
    type: 'aws.s3.DeleteBucket',
    label: 'S3 bucket deleted',
    description: 'An S3 bucket was deleted',
  },
  {
    type: 'aws.s3.PutBucketPublicAccessBlock',
    label: 'S3 public access block modified',
    description: 'The public access block configuration for a bucket was changed',
  },
  {
    type: 'aws.s3.DeleteBucketEncryption',
    label: 'S3 bucket encryption removed',
    description: 'Server-side encryption was disabled on an S3 bucket — weakens data-at-rest protection',
  },

  // ── CloudTrail ───────────────────────────────────────────────────────
  {
    type: 'aws.cloudtrail.StopLogging',
    label: 'CloudTrail logging stopped',
    description: 'CloudTrail logging was disabled for a trail — a common anti-forensics action',
  },
  {
    type: 'aws.cloudtrail.DeleteTrail',
    label: 'CloudTrail trail deleted',
    description: 'A CloudTrail trail was deleted',
  },
  {
    type: 'aws.cloudtrail.UpdateTrail',
    label: 'CloudTrail trail updated',
    description: 'A CloudTrail trail configuration was modified',
  },
  {
    type: 'aws.cloudtrail.PutEventSelectors',
    label: 'CloudTrail event selectors modified',
    description: 'The event selectors for a trail were changed — can reduce what gets logged (anti-forensics)',
  },

  // ── KMS ─────────────────────────────────────────────────────────────
  {
    type: 'aws.kms.ScheduleKeyDeletion',
    label: 'KMS key deletion scheduled',
    description: 'A KMS key was scheduled for deletion',
  },
  {
    type: 'aws.kms.DisableKey',
    label: 'KMS key disabled',
    description: 'A KMS key was disabled',
  },
  {
    type: 'aws.kms.CreateGrant',
    label: 'KMS grant created',
    description: 'A key grant was created — can share decrypt access cross-account without modifying the key policy',
  },
  {
    type: 'aws.kms.PutKeyPolicy',
    label: 'KMS key policy modified',
    description: 'The key policy was updated — can expand who can encrypt/decrypt with this key',
  },

  // ── Secrets Manager ─────────────────────────────────────────────────
  {
    type: 'aws.secretsmanager.DeleteSecret',
    label: 'Secret deleted',
    description: 'A secret was deleted from AWS Secrets Manager',
  },
  {
    type: 'aws.secretsmanager.GetSecretValue',
    label: 'Secret value retrieved',
    description: 'The value of a secret was retrieved from AWS Secrets Manager',
  },
  {
    type: 'aws.secretsmanager.PutSecretValue',
    label: 'Secret value updated',
    description: 'A secret value was overwritten in AWS Secrets Manager',
  },

  // ── AWS Config ───────────────────────────────────────────────────────
  {
    type: 'aws.config.StopConfigurationRecorder',
    label: 'Config recorder stopped',
    description: 'The AWS Config configuration recorder was stopped — disables resource change tracking',
  },
  {
    type: 'aws.config.DeleteConfigurationRecorder',
    label: 'Config recorder deleted',
    description: 'The AWS Config configuration recorder was deleted',
  },
  {
    type: 'aws.config.DeleteConfigRule',
    label: 'Config rule deleted',
    description: 'An AWS Config compliance rule was deleted — removes a guardrail',
  },
  {
    type: 'aws.config.PutConfigRule',
    label: 'Config rule modified',
    description: 'An AWS Config compliance rule was created or updated',
  },

  // ── Generic ─────────────────────────────────────────────────────────
  {
    type: 'aws.cloudtrail.event',
    label: 'CloudTrail event',
    description: 'A raw CloudTrail event that does not match a specific type',
  },
];
