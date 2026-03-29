# Event Types

Event types are the contract between a module's ingestion layer and its evaluators. Every event stored in Sentinel carries an `eventType` string that identifies the kind of activity the event represents. Evaluators use this string as their first guard: if the event type does not match what the evaluator expects, it returns `null` immediately without examining the payload.

**Source**: `packages/shared/src/module.ts` (interface), `modules/*/src/event-types.ts` (per-module definitions)

## EventTypeDefinition interface

```typescript
export interface EventTypeDefinition {
  /**
   * Fully qualified type string.
   * Convention: "{moduleId}.{resource}.{action}" or "{moduleId}.{category}.{action}"
   * Examples:
   *   'github.repository.visibility_changed'
   *   'chain.event.matched'
   *   'aws.iam.CreateUser'
   *   'infra.cert.expiring'
   *   'registry.docker.digest_change'
   */
  type: string;

  /** Human-readable label for UI display. */
  label: string;

  /** Description of what this event represents. */
  description: string;

  /** Optional Zod schema for the normalized payload. */
  payloadSchema?: ZodSchema;
}
```

## How modules declare event types

Each `DetectionModule` implementation declares its event types in an `eventTypes` array:

```typescript
export interface DetectionModule {
  readonly eventTypes: EventTypeDefinition[];
  // ...
}
```

Event types are declared in a dedicated file per module (e.g., `modules/github/src/event-types.ts`). At startup, the API collects all event types from all registered modules to power the event type dropdown in the correlation rule builder.

## Event normalization contract

Raw external events arrive through module-specific ingestion endpoints (webhooks, polling jobs, or queue consumers). The module's ingestion layer normalizes them into the `NormalizedEvent` schema before the event is stored and enqueued for evaluation:

```typescript
export interface NormalizedEvent {
  id: string;                     // UUID primary key
  orgId: string;                  // Organization that owns this event
  moduleId: string;               // Module that produced this event
  eventType: string;              // Must match a declared EventTypeDefinition.type
  externalId: string | null;      // Source system ID (e.g., GitHub delivery ID)
  payload: Record<string, unknown>; // Full normalized payload as JSONB
  occurredAt: Date;               // When the event occurred in the source system
  receivedAt: Date;               // When Sentinel received the event
}
```

### Normalization per module

| Module | Normalizer | Input | Strategy |
|---|---|---|---|
| **GitHub** | `modules/github/src/normalizer.ts` | Webhook payload + `X-GitHub-Event` header | Maps header + `action` field to `github.{resource}.{action}` type. Stores full webhook payload. |
| **Chain** | `modules/chain/src/normalizer.ts` | Decoded on-chain logs and state changes | Produces `chain.event.*` and `chain.state.*` types from decoded topics, arguments, and state diffs. |
| **AWS** | `modules/aws/src/normalizer.ts` | CloudTrail event records | Maps `eventName` and `eventSource` to `aws.{service}.{EventName}` types. |
| **Infrastructure** | `modules/infra/src/normalizer.ts` | Scan results and probe outcomes | Emits typed events for each finding (cert expiry, DNS change, header missing, etc.). |
| **Registry** | `modules/registry/src/normalizer.ts` | Docker Hub webhooks, npm registry changes, polling diffs | Produces `registry.docker.*`, `registry.npm.*`, `registry.verification.*`, and `registry.attribution.*` types. |

## Event storage

Normalized events are stored in the `events` table:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `org_id` | UUID | Foreign key to organizations |
| `module_id` | text | Module identifier string |
| `event_type` | text | Matches `EventTypeDefinition.type` |
| `external_id` | text | Source system delivery/event ID, nullable |
| `payload` | JSONB | Full normalized payload |
| `occurred_at` | timestamptz | Event timestamp from source system |
| `received_at` | timestamptz | Ingestion timestamp |

The `payload` column is JSONB, which enables GIN-indexed queries on payload fields. Evaluators access payload fields through the `EvalContext.event.payload` object at runtime, with no SQL-level payload introspection during the hot evaluation path.

## Data retention

Default retention for events is 90 days. Modules with high-volume event streams declare shorter retention policies via `DetectionModule.retentionPolicies`:

```typescript
export interface RetentionPolicy {
  table: string;
  timestampColumn: string;
  retentionDays: number;
  filter?: string;  // Optional SQL fragment (e.g., "module_id = 'aws'")
}
```

The `data-retention` worker handler periodically deletes expired rows based on these policies.

## Event types used in correlation rules

The correlation engine uses event type definitions as the primary filter when matching events to correlation rule steps. Each step in a correlation rule declares an `EventFilter`:

```typescript
interface EventFilter {
  moduleId?: string;                       // If set, event.moduleId must equal this value
  eventType?: string | string[];           // If set, event.eventType must be in this list
  conditions?: Condition[];                // Additional payload field conditions (AND logic)
}
```

When the correlation engine evaluates an event, it checks each step's filter:

1. If `filter.moduleId` is set and does not equal `event.moduleId`, the step does not match.
2. If `filter.eventType` is set, `event.eventType` must be in the allowed list (supports both single string and array).
3. If `filter.conditions` is non-empty, all conditions must pass against `event.payload` using the shared `evaluateConditions()` function.

## GitHub event types

| Type | Label |
|---|---|
| `github.repository.visibility_changed` | Repository visibility changed |
| `github.repository.created` | Repository created |
| `github.repository.deleted` | Repository deleted |
| `github.repository.archived` | Repository archived |
| `github.repository.unarchived` | Repository unarchived |
| `github.repository.transferred` | Repository transferred |
| `github.repository.renamed` | Repository renamed |
| `github.member.added` | Member added |
| `github.member.removed` | Member removed |
| `github.member.edited` | Member edited |
| `github.organization.member_added` | Organization member added |
| `github.organization.member_removed` | Organization member removed |
| `github.organization.member_invited` | Organization member invited |
| `github.team.created` | Team created |
| `github.team.deleted` | Team deleted |
| `github.team.edited` | Team edited |
| `github.team.added_to_repository` | Team added to repository |
| `github.team.removed_from_repository` | Team removed from repository |
| `github.branch_protection.created` | Branch protection created |
| `github.branch_protection.edited` | Branch protection modified |
| `github.branch_protection.deleted` | Branch protection deleted |
| `github.deploy_key.created` | Deploy key added |
| `github.deploy_key.deleted` | Deploy key removed |
| `github.secret_scanning.created` | Secret scanning alert |
| `github.secret_scanning.resolved` | Secret scanning alert resolved |
| `github.push` | Push event |
| `github.installation.created` | Installation created |
| `github.installation.deleted` | Installation deleted |
| `github.installation.suspended` | Installation suspended |
| `github.installation.unsuspended` | Installation unsuspended |

## Chain event types

| Type | Label | Description |
|---|---|---|
| `chain.event.matched` | On-chain event matched | Pre-matched on-chain log event produced by the block processor. Handled by `chain.event_match` evaluator (verifies event name matches expected signature). |
| `chain.log` | Raw on-chain log | Unfiltered log event matched by topic0. Handled by `chain.event_match`, `chain.windowed_count`, `chain.windowed_spike`, and `chain.windowed_sum` evaluators. |
| `chain.transaction` | On-chain transaction | Transaction event. Handled by `chain.function_call_match` evaluator. |
| `chain.balance_snapshot` | Balance snapshot | Periodic balance reading. Handled by `chain.balance_track` evaluator. |
| `chain.state_snapshot` | State snapshot | Storage slot reading. Handled by `chain.state_poll` evaluator. |
| `chain.view_call_result` | View call result | Contract view function return values. Handled by `chain.view_call` evaluator. |
| `chain.event.large_transfer` | Large transfer detected | High-value token or native currency transfer |
| `chain.event.contract_created` | Contract created | New smart contract deployment |
| `chain.state.balance_change` | Balance changed | Account balance crossed a monitored threshold |
| `chain.state.storage_change` | Storage changed | Contract storage slot value changed |
| `chain.state.view_call_change` | View call result changed | Contract view function returned a different value |
| `chain.event.fund_drainage` | Fund drainage detected | Significant outflow of funds from a monitored address |
| `chain.event.ownership_change` | Ownership change | Contract ownership transferred |
| `chain.block.reorg` | Chain reorganization | Block reorganization detected on monitored chain |

## AWS event types

AWS CloudTrail events are organized by service category. The following table lists the event types declared in `modules/aws/src/event-types.ts`:

### IAM events

| Type | Description |
|---|---|
| `aws.iam.CreateUser` | IAM user created |
| `aws.iam.DeleteUser` | IAM user deleted |
| `aws.iam.CreateAccessKey` | Access key created |
| `aws.iam.DeleteAccessKey` | Access key deleted |
| `aws.iam.AttachUserPolicy` | Policy attached to user |
| `aws.iam.AttachRolePolicy` | Policy attached to role |
| `aws.iam.CreateRole` | IAM role created |
| `aws.iam.DeleteRole` | IAM role deleted |
| `aws.iam.UpdateAssumeRolePolicy` | Trust policy modified |
| `aws.iam.PutUserPolicy` | Inline policy added to user |
| `aws.iam.PutRolePolicy` | Inline policy added to role |
| `aws.iam.AddUserToGroup` | User added to group |
| `aws.iam.CreateLoginProfile` | Console login profile created |
| `aws.iam.UpdateLoginProfile` | Console login profile modified |
| `aws.iam.DeactivateMFADevice` | MFA device deactivated |
| `aws.iam.AssumeRoleWithWebIdentity` | Role assumed via web identity |
| `aws.iam.AssumeRoleWithSAML` | Role assumed via SAML |

### Sign-in events

| Type | Description |
|---|---|
| `aws.signin.ConsoleLogin` | AWS Management Console login |

### EC2 events

| Type | Description |
|---|---|
| `aws.ec2.AuthorizeSecurityGroupIngress` | Inbound security group rule added |
| `aws.ec2.AuthorizeSecurityGroupEgress` | Outbound security group rule added |
| `aws.ec2.RevokeSecurityGroupIngress` | Inbound security group rule removed |
| `aws.ec2.CreateSecurityGroup` | Security group created |
| `aws.ec2.TerminateInstances` | Instances terminated |
| `aws.ec2.StopInstances` | Instances stopped |
| `aws.ec2.RunInstances` | Instances launched |
| `aws.ec2.CreateKeyPair` | SSH key pair created |
| `aws.ec2.ImportKeyPair` | SSH key pair imported |
| `aws.ec2.ModifyInstanceAttribute` | Instance attribute modified |
| `aws.ec2.SpotInstanceInterruption` | Spot instance interruption notice |

### S3 events

| Type | Description |
|---|---|
| `aws.s3.PutBucketAcl` | Bucket ACL modified |
| `aws.s3.GetBucketAcl` | Bucket ACL read |
| `aws.s3.PutBucketPolicy` | Bucket policy modified |
| `aws.s3.DeleteBucket` | Bucket deleted |
| `aws.s3.PutBucketPublicAccessBlock` | Public access block modified |
| `aws.s3.DeleteBucketEncryption` | Bucket encryption removed |

### CloudTrail events

| Type | Description |
|---|---|
| `aws.cloudtrail.StopLogging` | Trail logging stopped |
| `aws.cloudtrail.DeleteTrail` | Trail deleted |
| `aws.cloudtrail.UpdateTrail` | Trail configuration modified |
| `aws.cloudtrail.PutEventSelectors` | Event selectors modified |
| `aws.cloudtrail.event` | Generic CloudTrail event (catch-all) |

### KMS events

| Type | Description |
|---|---|
| `aws.kms.ScheduleKeyDeletion` | KMS key scheduled for deletion |
| `aws.kms.DisableKey` | KMS key disabled |
| `aws.kms.CreateGrant` | KMS grant created |
| `aws.kms.PutKeyPolicy` | KMS key policy modified |

### Secrets Manager events

| Type | Description |
|---|---|
| `aws.secretsmanager.DeleteSecret` | Secret deleted |
| `aws.secretsmanager.GetSecretValue` | Secret value accessed |
| `aws.secretsmanager.PutSecretValue` | Secret value updated |

### AWS Config events

| Type | Description |
|---|---|
| `aws.config.StopConfigurationRecorder` | Config recorder stopped |
| `aws.config.DeleteConfigurationRecorder` | Config recorder deleted |
| `aws.config.DeleteConfigRule` | Config rule deleted |
| `aws.config.PutConfigRule` | Config rule created or modified |

## Infrastructure event types

| Type | Label | Description |
|---|---|---|
| `infra.scan.completed` | Scan completed | Aggregate scan result for a monitored host |
| `infra.probe.completed` | Probe completed | Individual probe result for a host |
| `infra.cert.expiring` | Certificate expiring | Certificate expiry within threshold |
| `infra.cert.expired` | Certificate expired | Certificate has already expired |
| `infra.cert.issue` | Certificate issue | Certificate validity problem detected |
| `infra.tls.weakness` | TLS weakness | Weak TLS configuration detected |
| `infra.dns.change` | DNS change | DNS record changed from baseline |
| `infra.header.missing` | Security header missing | Required HTTP security header absent |
| `infra.host.unreachable` | Host unreachable | Host failed reachability probe |
| `infra.host.slow` | Host slow | Host response time exceeds threshold |
| `infra.score.degraded` | Score degraded | Security score dropped below threshold |
| `infra.subdomain.discovered` | New subdomain | New subdomain found in CT logs |
| `infra.whois.expiring` | Domain expiring | Domain registration nearing expiry |

## Registry event types

### Docker events

| Type | Label | Description |
|---|---|---|
| `registry.docker.digest_change` | Docker image digest changed | A monitored Docker tag now points to a different image digest |
| `registry.docker.new_tag` | Docker tag added | A new tag appeared on a monitored repository |
| `registry.docker.tag_removed` | Docker tag removed | A tag was removed from a monitored repository |

### npm events

| Type | Label | Description |
|---|---|---|
| `registry.npm.version_published` | npm version published | A new version was published to a monitored package |
| `registry.npm.version_deprecated` | npm version deprecated | A version was deprecated |
| `registry.npm.version_unpublished` | npm version unpublished | A previously published version was removed from the registry |
| `registry.npm.maintainer_changed` | npm maintainer changed | Maintainers were added or removed |
| `registry.npm.dist_tag_updated` | npm dist-tag updated | A dist-tag now points to a different version |
| `registry.npm.new_tag` | npm dist-tag added | A new dist-tag appeared |
| `registry.npm.tag_removed` | npm dist-tag removed | A dist-tag was removed |

### Verification events

| Type | Label | Description |
|---|---|---|
| `registry.verification.signature_missing` | Cosign signature missing | A release artifact lacks a cosign signature |
| `registry.verification.provenance_missing` | SLSA provenance missing | A release artifact lacks a SLSA provenance attestation |
| `registry.verification.signature_invalid` | Cosign signature invalid | A cosign signature failed verification |
| `registry.verification.provenance_invalid` | SLSA provenance invalid | A SLSA provenance attestation failed verification |

### Attribution events

| Type | Label | Description |
|---|---|---|
| `registry.attribution.unattributed_change` | Unattributed change | A release changed without CI attribution metadata |
| `registry.attribution.attribution_mismatch` | Attribution mismatch | CI attribution does not match the expected workflow, actor, or branch |
