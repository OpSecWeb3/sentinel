import type { DetectionTemplate, TemplateInput } from '@sentinel/shared/module';

/** Shared optional scoping inputs added to all AWS templates. */
const SCOPING_INPUTS: TemplateInput[] = [
  {
    key: 'accountIds',
    label: 'Limit to AWS accounts',
    type: 'string-array',
    required: false,
    placeholder: '123456789012',
    help: 'Only fire for events from these account IDs. Leave empty for all accounts.',
  },
  {
    key: 'regions',
    label: 'Limit to AWS regions',
    type: 'string-array',
    required: false,
    placeholder: 'us-east-1\neu-west-2',
    help: 'Only fire for events from these regions. Leave empty for all regions.',
  },
];

const _templates: DetectionTemplate[] = [
  // ── Identity & Access ────────────────────────────────────────────────
  {
    slug: 'aws-root-account-usage',
    name: 'Root Account Activity Monitor',
    description: 'Alert whenever the root account is used for any API action. Root usage should be extremely rare — most operational tasks should use IAM roles.',
    category: 'identity',
    severity: 'critical',
    inputs: [
      {
        key: 'excludeEventNames',
        label: 'Exclude event names',
        type: 'string-array',
        required: false,
        placeholder: 'GetBillingDetails',
        help: 'CloudTrail events to suppress for the root account (e.g. expected billing console activity).',
      },
    ],
    rules: [
      {
        ruleType: 'aws.root_activity',
        config: { excludeEventNames: [], includeFailedActions: true },
        action: 'alert',
        priority: 10,
      },
    ],
  },
  {
    slug: 'aws-console-login-anomaly',
    name: 'Console Login Monitor',
    description: 'Alert on console login failures and root account logins. Failed logins may indicate credential stuffing; root logins are always high-risk.',
    category: 'identity',
    severity: 'high',
    inputs: [
      {
        key: 'alertOnLoginFailure',
        label: 'Alert on failed logins',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'alertOnRootLogin',
        label: 'Alert on root console login',
        type: 'boolean',
        required: false,
        default: true,
      },
      {
        key: 'alertOnNoMfa',
        label: 'Alert on login without MFA',
        type: 'boolean',
        required: false,
        default: false,
      },
    ],
    rules: [
      {
        ruleType: 'aws.auth_failure',
        config: { alertOnLoginFailure: true, alertOnRootLogin: true, alertOnNoMfa: false },
        action: 'alert',
      },
    ],
  },

  // ── IAM Changes ─────────────────────────────────────────────────────
  {
    slug: 'aws-iam-user-changes',
    name: 'IAM User Changes',
    description: 'Alert when IAM users are created or deleted, or when access keys are generated. Unexpected IAM user changes are a common indicator of account compromise or insider threat.',
    category: 'identity',
    severity: 'high',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['CreateUser', 'DeleteUser', 'CreateAccessKey', 'DeleteAccessKey', 'CreateLoginProfile', 'UpdateLoginProfile'],
          eventSources: ['iam.amazonaws.com'],
          alertTitle: 'IAM change: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'aws-iam-privilege-escalation',
    name: 'IAM Privilege Escalation Detection',
    description: 'Alert on IAM policy attachments and inline policy modifications that could indicate a privilege escalation attempt.',
    category: 'identity',
    severity: 'critical',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: [
            'AttachUserPolicy', 'AttachRolePolicy', 'AttachGroupPolicy',
            'PutUserPolicy', 'PutRolePolicy', 'PutGroupPolicy',
            'CreatePolicyVersion', 'SetDefaultPolicyVersion',
            'UpdateAssumeRolePolicy', 'AddUserToGroup',
          ],
          eventSources: ['iam.amazonaws.com'],
          alertTitle: 'IAM privilege change: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'aws-federated-identity-abuse',
    name: 'Federated Identity Role Assumption',
    description: 'Alert when roles are assumed via web identity (OIDC/OAuth) or SAML. Covers GitHub Actions, Google Workspaces, Okta and similar IdPs. Abuse can grant AWS access without IAM credentials.',
    category: 'identity',
    severity: 'high',
    inputs: [
      {
        key: 'principalArnPatterns',
        label: 'Restrict to principal ARN patterns',
        type: 'string-array',
        required: false,
        placeholder: 'arn:aws:sts::*:assumed-role/suspicious-*',
        help: 'Leave empty to alert on all federated role assumptions. Glob patterns.',
      },
    ],
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['AssumeRoleWithWebIdentity', 'AssumeRoleWithSAML'],
          eventSources: ['sts.amazonaws.com'],
          alertTitle: 'Federated role assumption: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'aws-mfa-deactivated',
    name: 'MFA Deactivation Alert',
    description: 'Alert when an MFA device is deactivated for any IAM user. Disabling MFA weakens authentication and often precedes account takeover.',
    category: 'identity',
    severity: 'high',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['DeactivateMFADevice', 'DeleteVirtualMFADevice'],
          eventSources: ['iam.amazonaws.com'],
          alertTitle: 'MFA deactivated by {{principalId}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Anti-Forensics / Defense Evasion ─────────────────────────────────
  {
    slug: 'aws-cloudtrail-disabled',
    name: 'CloudTrail Tampering',
    description: 'Alert when CloudTrail logging is stopped, a trail is deleted, or event selectors are modified to reduce what gets logged. This is a textbook anti-forensics technique.',
    category: 'defense-evasion',
    severity: 'critical',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['StopLogging', 'DeleteTrail', 'UpdateTrail', 'PutEventSelectors'],
          eventSources: ['cloudtrail.amazonaws.com'],
          alertTitle: 'CloudTrail tampered: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
    ],
  },
  {
    slug: 'aws-config-evasion',
    name: 'AWS Config Evasion',
    description: 'Alert when the AWS Config recorder is stopped or compliance rules are deleted. Attackers disable Config to avoid detection of policy violations and resource changes.',
    category: 'defense-evasion',
    severity: 'critical',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['StopConfigurationRecorder', 'DeleteConfigurationRecorder', 'DeleteConfigRule'],
          eventSources: ['config.amazonaws.com'],
          alertTitle: 'AWS Config tampered: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
    ],
  },

  // ── Infrastructure ───────────────────────────────────────────────────
  {
    slug: 'aws-security-group-opened',
    name: 'Security Group Open Ingress',
    description: 'Alert when security group ingress rules are added. Wide-open rules (0.0.0.0/0) are common misconfigurations that expose services to the internet.',
    category: 'network',
    severity: 'high',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['AuthorizeSecurityGroupIngress', 'CreateSecurityGroup'],
          eventSources: ['ec2.amazonaws.com'],
          alertTitle: 'Security group rule added: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'aws-ec2-ssh-access',
    name: 'EC2 SSH Key Pair Changes',
    description: 'Alert when new SSH key pairs are created or imported. New key pairs grant persistent SSH access to EC2 instances and are a common attacker persistence mechanism.',
    category: 'network',
    severity: 'high',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['CreateKeyPair', 'ImportKeyPair'],
          eventSources: ['ec2.amazonaws.com'],
          alertTitle: 'SSH key pair change: {{eventName}} by {{principalId}} in {{awsRegion}}',
        },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'aws-ec2-unusual-launch',
    name: 'Unusual EC2 Instance Launch',
    description: 'Alert on EC2 instance launches and attribute modifications. Unusual regions or instance types can indicate unauthorized workloads (crypto mining, C2 infrastructure).',
    category: 'compute',
    severity: 'medium',
    inputs: [
      {
        key: 'regions',
        label: 'Expected regions (alert outside these)',
        type: 'string-array',
        required: false,
        placeholder: 'us-east-1\nus-west-2',
        help: 'Alert when instances are launched outside these regions. Leave empty to alert on all launches.',
      },
    ],
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['RunInstances'],
          eventSources: ['ec2.amazonaws.com'],
          alertTitle: 'EC2 instance launched: {{eventName}} by {{principalId}} in {{awsRegion}}',
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['ModifyInstanceAttribute'],
          eventSources: ['ec2.amazonaws.com'],
          alertTitle: 'EC2 instance attribute modified by {{principalId}} in {{awsRegion}}',
        },
        action: 'alert',
        priority: 20,
      },
    ],
  },

  // ── Spot Instance Evictions ──────────────────────────────────────────
  {
    slug: 'aws-spot-eviction',
    name: 'Spot Instance Eviction Monitor',
    description: 'Alert when AWS interrupts (evicts) spot instances. The 2-minute interruption warning fires before termination. Configure EventBridge → SQS to receive these events.',
    category: 'compute',
    severity: 'medium',
    inputs: [
      {
        key: 'watchInstanceIds',
        label: 'Watch specific instance IDs',
        type: 'string-array',
        required: false,
        placeholder: 'i-0abc123def456',
        help: 'Leave empty to alert on all spot evictions.',
      },
      {
        key: 'regions',
        label: 'AWS regions',
        type: 'string-array',
        required: false,
        placeholder: 'us-east-1',
        help: 'Limit to specific regions. Leave empty for all.',
      },
      {
        key: 'severity',
        label: 'Alert severity',
        type: 'select',
        required: false,
        default: 'medium',
        options: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'critical', label: 'Critical' },
        ],
        help: 'Set higher if spot instances run critical workloads.',
      },
    ],
    rules: [
      {
        ruleType: 'aws.spot_eviction',
        config: { watchInstanceIds: [], regions: [], severity: 'medium' },
        action: 'alert',
      },
    ],
  },

  // ── Data & Storage ───────────────────────────────────────────────────
  {
    slug: 'aws-s3-public-access',
    name: 'S3 Public Access Changes',
    description: 'Alert when S3 bucket ACLs, policies, encryption, or public access blocks are modified. Misconfigured S3 buckets are a leading cause of data breaches.',
    category: 'data',
    severity: 'critical',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['PutBucketAcl', 'PutBucketPolicy', 'PutBucketPublicAccessBlock', 'DeleteBucketPolicy', 'DeleteBucketEncryption'],
          eventSources: ['s3.amazonaws.com'],
          alertTitle: 'S3 bucket change: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'aws-kms-key-action',
    name: 'KMS Key Deletion, Disable, or Grant',
    description: 'Alert when encryption keys are disabled, scheduled for deletion, or grants are created that share key access. Losing KMS keys can make encrypted data permanently inaccessible; grants enable silent cross-account exfiltration.',
    category: 'data',
    severity: 'critical',
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['ScheduleKeyDeletion', 'DisableKey', 'DeleteImportedKeyMaterial'],
          eventSources: ['kms.amazonaws.com'],
          alertTitle: 'KMS key action: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['CreateGrant', 'PutKeyPolicy'],
          eventSources: ['kms.amazonaws.com'],
          alertTitle: 'KMS access expanded: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 20,
      },
    ],
  },
  {
    slug: 'aws-secrets-access',
    name: 'Secrets Manager Access Monitor',
    description: 'Alert on secret reads and deletions from AWS Secrets Manager. GetSecretValue from unusual callers may indicate credential theft; deletions can cause operational outages.',
    category: 'data',
    severity: 'high',
    inputs: [
      {
        key: 'principalArnPatterns',
        label: 'Alert on principals matching patterns',
        type: 'string-array',
        required: false,
        placeholder: 'arn:aws:sts::*:assumed-role/suspicious-*',
        help: 'Leave empty to alert on all secret accesses. Useful to scope to specific roles.',
      },
    ],
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['GetSecretValue'],
          eventSources: ['secretsmanager.amazonaws.com'],
          alertTitle: 'Secret retrieved: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['DeleteSecret', 'PutSecretValue'],
          eventSources: ['secretsmanager.amazonaws.com'],
          alertTitle: 'Secret modified: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
    ],
  },

  // ── Reconnaissance ───────────────────────────────────────────────────
  {
    slug: 'aws-access-denied',
    name: 'Access Denied Monitor',
    description: 'Alert on access denied errors. Repeated access denials can indicate a compromised credential attempting to enumerate permissions or escalate privileges.',
    category: 'reconnaissance',
    severity: 'medium',
    inputs: [
      {
        key: 'eventSources',
        label: 'Limit to AWS services',
        type: 'string-array',
        required: false,
        placeholder: 'iam.amazonaws.com\ns3.amazonaws.com',
        help: 'Leave empty to watch all services. One per line.',
      },
    ],
    rules: [
      {
        ruleType: 'aws.event_match',
        config: {
          errorEventsOnly: true,
          errorCodes: ['AccessDenied', 'UnauthorizedOperation', 'Client.UnauthorizedOperation'],
          alertTitle: 'Access denied: {{eventName}} by {{principalId}} in {{awsRegion}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Comprehensive ─────────────────────────────────────────────────────
  {
    slug: 'aws-full-security',
    name: 'AWS Full Security Suite',
    description: 'Enable all Tier 1 AWS security monitors in one detection. Covers root usage, IAM privilege changes, CloudTrail/Config tampering, KMS key abuse, federated identity misuse, and console anomalies.',
    category: 'comprehensive',
    severity: 'critical',
    rules: [
      // Tier 1: root
      {
        ruleType: 'aws.root_activity',
        config: { excludeEventNames: [], includeFailedActions: true },
        action: 'alert',
        priority: 10,
      },
      // Tier 1: console auth
      {
        ruleType: 'aws.auth_failure',
        config: { alertOnLoginFailure: true, alertOnRootLogin: true, alertOnNoMfa: false },
        action: 'alert',
        priority: 10,
      },
      // Tier 1: CloudTrail tampering (including PutEventSelectors)
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['StopLogging', 'DeleteTrail', 'PutEventSelectors'],
          eventSources: ['cloudtrail.amazonaws.com'],
          alertTitle: 'CloudTrail tampered: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
      // Config evasion
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['StopConfigurationRecorder', 'DeleteConfigRule'],
          eventSources: ['config.amazonaws.com'],
          alertTitle: 'AWS Config tampered: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 10,
      },
      // KMS destruction + access expansion
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['ScheduleKeyDeletion', 'DisableKey', 'CreateGrant', 'PutKeyPolicy'],
          eventSources: ['kms.amazonaws.com'],
          alertTitle: 'KMS action: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 20,
      },
      // Tier 1: IAM privilege escalation
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: [
            'AttachUserPolicy', 'AttachRolePolicy',
            'PutUserPolicy', 'PutRolePolicy',
            'UpdateAssumeRolePolicy', 'CreatePolicyVersion',
          ],
          eventSources: ['iam.amazonaws.com'],
          alertTitle: 'IAM privilege change: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 20,
      },
      // Tier 1: IAM user creation / access key
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['CreateUser', 'DeleteUser', 'CreateAccessKey', 'DeactivateMFADevice'],
          eventSources: ['iam.amazonaws.com'],
          alertTitle: 'IAM user change: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 30,
      },
      // Federated identity abuse
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['AssumeRoleWithWebIdentity', 'AssumeRoleWithSAML'],
          eventSources: ['sts.amazonaws.com'],
          alertTitle: 'Federated role assumption: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 30,
      },
      // S3 exposure
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['PutBucketAcl', 'PutBucketPolicy', 'DeleteBucketPolicy', 'DeleteBucketEncryption'],
          eventSources: ['s3.amazonaws.com'],
          alertTitle: 'S3 bucket change: {{eventName}} by {{principalId}}',
        },
        action: 'alert',
        priority: 40,
      },
      // SSH key persistence
      {
        ruleType: 'aws.event_match',
        config: {
          eventNames: ['CreateKeyPair', 'ImportKeyPair'],
          eventSources: ['ec2.amazonaws.com'],
          alertTitle: 'SSH key pair change: {{eventName}} by {{principalId}} in {{awsRegion}}',
        },
        action: 'alert',
        priority: 40,
      },
    ],
  },
];

// Append account and region scoping inputs to every template so users can
// narrow detections without creating custom rules.
export const templates: DetectionTemplate[] = _templates.map((t) => {
  const existing = t.inputs ?? [];
  // Skip adding regions if the template already defines a 'regions' input
  // (e.g. spot eviction, unusual EC2 launch) to avoid duplicates.
  const hasRegions = existing.some((i) => i.key === 'regions');
  const extra = hasRegions
    ? SCOPING_INPUTS.filter((i) => i.key !== 'regions')
    : SCOPING_INPUTS;
  return { ...t, inputs: [...existing, ...extra] };
});
