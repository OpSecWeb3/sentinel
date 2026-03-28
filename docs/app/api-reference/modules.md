# Modules and Analytics API

The Modules API exposes metadata about all detection modules registered in the Sentinel platform and module-specific analytics endpoints for querying domain-specific data (blockchain transactions, GitHub activity, infrastructure scans, AWS CloudTrail events, and registry artifacts).

**Base URL:** `http://localhost:4000`

All endpoints require authentication via a session cookie or an `Authorization: Bearer <api-key>` header, and active organisation membership.

---

## Authentication and scopes

| Method | Required role | Required scope |
|--------|--------------|----------------|
| `GET` | viewer, editor, admin | `api:read` |

---

## Registered modules

Sentinel ships with five modules. Each module is a self-contained package that contributes evaluators, event types, and templates to the platform.

| Module ID | Name | Description |
|-----------|------|-------------|
| `github` | GitHub | Monitors GitHub organisation activity via webhooks. |
| `registry` | Registry | Monitors container and package registry events. |
| `chain` | Chain | Monitors blockchain/smart-contract events. |
| `infra` | Infra | Monitors infrastructure and host-level events. |
| `aws` | AWS | Monitors AWS CloudTrail and GuardDuty events. |

---

## Module metadata endpoints

### Get module metadata

```
GET /api/modules/metadata
```

Returns the list of all registered modules with their event type definitions. This endpoint is the primary source of truth for populating event-type selectors in the correlation rule form and any UI component that needs to enumerate valid `moduleId` / `eventType` pairs.

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": "github",
      "name": "GitHub",
      "eventTypes": [
        {
          "type": "github.repository.publicized",
          "label": "Repository Made Public",
          "description": "A repository's visibility was changed to public."
        }
      ]
    },
    {
      "id": "registry",
      "name": "Registry",
      "eventTypes": [...]
    }
  ]
}
```

**Module object**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Module identifier (e.g., `github`). Matches `moduleId` used in detections, rules, and events. |
| `name` | `string` | Human-readable module name. |
| `eventTypes` | `EventTypeDefinition[]` | All event types this module can produce. |

**EventTypeDefinition object**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Fully-qualified event type string. Use this in `eventFilter.eventType` within correlation rules. |
| `label` | `string` | Short human-readable label for UI dropdowns. |
| `description` | `string` | Longer description of what this event represents. |

**HTTP status codes**

| Code | Condition |
|------|-----------|
| `200` | Module list returned. |
| `503` | Module registry not initialised (server misconfiguration). |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/modules/metadata"
```

---

### Get sample event fields

```
GET /api/modules/metadata/sample-fields
```

Extracts field paths from the most recent real event of a given `moduleId` / `eventType` pair recorded in your organisation. Use this endpoint to populate field-path autocomplete inputs in the correlation rule form.

If no event of the requested type has been received yet, the response returns an empty `fields` array with `hasData: false`.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `moduleId` | `string` | Yes | Module ID (e.g., `github`). |
| `eventType` | `string` | Yes | Event type string (e.g., `github.repository.publicized`). |

**Response `200 OK`**

```json
{
  "data": {
    "fields": [
      { "path": "repository.full_name", "type": "string", "sample": "my-org/my-repo" },
      { "path": "sender.login", "type": "string", "sample": "octocat" },
      { "path": "sender.id", "type": "number", "sample": 1 }
    ],
    "hasData": true
  }
}
```

**Field entry object**

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Dot-notation path into the event payload. Use directly in `eventFilter.conditions[].field` and `correlationKey[].field`. |
| `type` | `"string" \| "number" \| "boolean" \| "null" \| "array"` | JavaScript type of the field value. |
| `sample` | `unknown` | Sample value. Strings longer than 80 characters are truncated. Arrays are represented as `"[N items]"`. |

The extractor recurses into nested objects up to 6 levels deep. Array elements are not iterated.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/modules/metadata/sample-fields?moduleId=github&eventType=github.repository.publicized"
```

---

## Chain analytics

Blockchain-specific analytics endpoints under `/api/chain`.

### Address activity

```
GET /api/chain/address-activity
```

Returns on-chain events for a specific address.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `address` | `string` | Yes | Blockchain address. |
| `networkId` | `integer` | No | Filter by network ID. |
| `from` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `to` | `string (ISO 8601 datetime)` | No | End of time range. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/chain/address-activity?address=0x1234...abcd&limit=20"
```

### Balance history

```
GET /api/chain/balance-history
```

Returns balance snapshot history from the `chain_state_snapshots` table. Scoped to the org via a rules join.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ruleId` | `string (UUID)` | No | Filter by rule ID. |
| `address` | `string` | No | Filter by address. |
| `networkId` | `integer` | No | Filter by network ID. |
| `limit` | `integer (1-500)` | No | Maximum results. Default: `100`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/chain/balance-history?address=0x1234...abcd&limit=50"
```

### State history

```
GET /api/chain/state-history
```

Returns storage slot value timeline from contract state polling.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ruleId` | `string (UUID)` | No | Filter by rule ID. |
| `address` | `string` | No | Filter by contract address. |
| `slot` | `string` | No | Filter by storage slot. |
| `limit` | `integer (1-500)` | No | Maximum results. Default: `100`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/chain/state-history?address=0x1234...abcd&slot=0x0"
```

### Network status

```
GET /api/chain/network-status
```

Returns block cursor positions per network, joined with network metadata. This endpoint is not scoped to an org -- it returns global network status.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/chain/network-status"
```

### RPC usage

```
GET /api/chain/rpc-usage
```

Returns hourly RPC call counts for the organisation.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `networkId` | `integer` | No | Filter by network ID. |
| `since` | `string (ISO 8601 datetime)` | No | Start of time range. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/chain/rpc-usage?since=2026-03-01T00:00:00Z"
```

---

## GitHub analytics

GitHub-specific analytics endpoints under `/api/github`.

### Repository activity

```
GET /api/github/repo-activity
```

Returns GitHub events for a specific repository.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoFullName` | `string` | Yes | Repository full name (e.g., `my-org/my-repo`). Case-insensitive partial match on payload `repository` field. |
| `eventType` | `string` | No | Filter by event type. |
| `since` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/github/repo-activity?repoFullName=my-org/my-repo&limit=20"
```

### Actor activity

```
GET /api/github/actor-activity
```

Returns all GitHub events attributed to a specific actor login.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `login` | `string` | Yes | GitHub username/login. |
| `since` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/github/actor-activity?login=octocat&limit=20"
```

### List installations

```
GET /api/github/installations
```

Returns GitHub App installations for the organisation.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/github/installations"
```

### List repositories

```
GET /api/github/repos
```

Returns monitored repositories for the organisation.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `search` | `string (max 255)` | No | Case-insensitive substring match on `fullName`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/github/repos?search=my-repo"
```

---

## Registry analytics

Registry-specific analytics endpoints under `/api/registry`.

### Artifact summary

```
GET /api/registry/artifacts/summary
```

Returns a list of monitored artifacts with tag counts and last push dates.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/registry/artifacts/summary"
```

### Digest history

```
GET /api/registry/digest-history
```

Returns digest change log for a specific artifact.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifactName` | `string` | Yes | Artifact name. |
| `tag` | `string` | No | Filter by tag/version. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/registry/digest-history?artifactName=my-org/my-image&limit=20"
```

### Attribution report

```
GET /api/registry/attribution-report
```

Returns attribution status for artifact events, with a summary breakdown by status.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifactName` | `string` | No | Filter by artifact name. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/registry/attribution-report?artifactName=my-org/my-image"
```

### Unsigned releases

```
GET /api/registry/unsigned-releases
```

Returns artifact versions that lack cosign signatures or SLSA provenance.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifactName` | `string` | No | Filter by artifact name. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/registry/unsigned-releases"
```

### CI notifications

```
GET /api/registry/ci-notifications
```

Returns recent CI pipeline push notification records.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/registry/ci-notifications?since=2026-03-01T00:00:00Z"
```

---

## Infra analytics

Infrastructure-specific analytics endpoints under `/api/infra`.

### List hosts

```
GET /api/infra/hosts
```

Returns monitored infrastructure hosts for the organisation.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `search` | `string (max 255)` | No | Case-insensitive substring match on hostname. |
| `isRoot` | `"true" \| "false"` | No | Filter by root domain status. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts?search=example.com"
```

### Host intelligence

```
GET /api/infra/hosts/:hostname
```

Returns full host intelligence including the latest snapshot, CDN origin records, and DNS records.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts/example.com"
```

### CDN origin records

```
GET /api/infra/hosts/:hostname/origin
```

Returns CDN origin records for a host, ordered by observation date descending.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts/example.com/origin"
```

### DNS change history

```
GET /api/infra/hosts/:hostname/dns-history
```

Returns the DNS change log for a host.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `since` | `string (ISO 8601 datetime)` | No | Start of time range. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts/example.com/dns-history?since=2026-01-01T00:00:00Z"
```

### Certificate expiry

```
GET /api/infra/cert-expiry
```

Returns certificates expiring within the specified number of days.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `daysAhead` | `integer (positive)` | No | Number of days to look ahead. Default: `30`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/cert-expiry?daysAhead=14"
```

### TLS analysis

```
GET /api/infra/hosts/:hostname/tls
```

Returns the latest TLS analysis for a host.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts/example.com/tls"
```

### WHOIS record

```
GET /api/infra/hosts/:hostname/whois
```

Returns the latest WHOIS record for a host.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts/example.com/whois"
```

### Security score history

```
GET /api/infra/hosts/:hostname/score
```

Returns the security score history for a host.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | `integer (1-90)` | No | Maximum entries. Default: `30`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/infra/hosts/example.com/score?limit=30"
```

---

## AWS analytics

AWS CloudTrail analytics endpoints under `/api/aws`.

### Query CloudTrail events

```
GET /api/aws/events
```

Returns raw CloudTrail events with pagination and filters.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `eventName` | `string` | No | Filter by CloudTrail event name (e.g., `CreateUser`). |
| `eventSource` | `string` | No | Filter by event source (e.g., `iam.amazonaws.com`). |
| `principalId` | `string` | No | Filter by IAM principal ID. |
| `resourceArn` | `string` | No | Filter by resource ARN (uses JSONB containment). |
| `region` | `string` | No | Filter by AWS region. |
| `errorCode` | `string` | No | Filter by error code (e.g., `AccessDenied`). |
| `from` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `to` | `string (ISO 8601 datetime)` | No | End of time range. |
| `limit` | `integer (1-200)` | No | Results per page. Default: `50`. |
| `page` | `integer (>=1)` | No | Page number. Default: `1`. |

**Response `200 OK`**

```json
{
  "data": [
    {
      "id": 1,
      "cloudTrailEventId": "abc-123-...",
      "eventName": "CreateUser",
      "eventSource": "iam.amazonaws.com",
      "awsRegion": "us-east-1",
      "principalId": "AIDA...",
      "userArn": "arn:aws:iam::123456789012:user/admin",
      "accountId": "123456789012",
      "sourceIpAddress": "203.0.113.1",
      "errorCode": null,
      "resources": [{"ARN": "arn:aws:iam::123456789012:user/newuser"}],
      "eventTime": "2026-01-15T10:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 245,
    "totalPages": 5
  }
}
```

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/aws/events?eventName=CreateUser&region=us-east-1&limit=20"
```

### Principal activity

```
GET /api/aws/principal/:principalId/activity
```

Returns all CloudTrail actions by a specific IAM principal, with a summary breakdown by event name and error code.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `principalId` | `string` | IAM principal ID. |

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `to` | `string (ISO 8601 datetime)` | No | End of time range. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/aws/principal/AIDA.../activity?from=2026-01-01T00:00:00Z"
```

### Resource history

```
GET /api/aws/resource-history
```

Returns all CloudTrail events touching a specific resource ARN.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resourceArn` | `string` | Yes | AWS resource ARN. |
| `from` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `to` | `string (ISO 8601 datetime)` | No | End of time range. |
| `limit` | `integer (1-200)` | No | Maximum results. Default: `50`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/aws/resource-history?resourceArn=arn:aws:iam::123456789012:user/admin"
```

### Error patterns

```
GET /api/aws/error-patterns
```

Returns systematic access denials grouped by principal and action. Useful for detecting brute-force or misconfigured IAM policies.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `to` | `string (ISO 8601 datetime)` | No | End of time range. |
| `limit` | `integer (1-100)` | No | Maximum results. Default: `20`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/aws/error-patterns?from=2026-03-01T00:00:00Z"
```

### Top actors

```
GET /api/aws/top-actors
```

Returns the most active IAM principals by event count.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | `string (ISO 8601 datetime)` | No | Start of time range. |
| `to` | `string (ISO 8601 datetime)` | No | End of time range. |
| `limit` | `integer (1-50)` | No | Maximum results. Default: `20`. |

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/aws/top-actors?from=2026-03-01T00:00:00Z&limit=10"
```

### Integration summary

```
GET /api/aws/integrations/summary
```

Returns AWS integration health status for all configured accounts/integrations.

**cURL example**

```bash
curl -s \
  -H "Authorization: Bearer sk_..." \
  "http://localhost:4000/api/aws/integrations/summary"
```

---

## Slack integration endpoints

Slack integration management is under `/integrations/slack`. These endpoints handle OAuth installation and channel search.

### Get Slack connection status

```
GET /integrations/slack
```

Returns whether Slack is connected for the organisation.

**cURL example**

```bash
curl -s \
  -b cookies.txt \
  "http://localhost:4000/integrations/slack"
```

**Response (connected):**

```json
{
  "connected": true,
  "teamId": "T01234ABC",
  "teamName": "Acme Security",
  "installedAt": "2026-01-10T09:00:00.000Z"
}
```

### Get Slack OAuth install URL

```
GET /integrations/slack/install
```

Returns the Slack OAuth authorization URL. Redirect the user to this URL to begin the installation flow.

**cURL example**

```bash
curl -s \
  -b cookies.txt \
  "http://localhost:4000/integrations/slack/install"
```

**Response:**

```json
{ "url": "https://slack.com/oauth/v2/authorize?client_id=...&scope=chat:write,channels:read,groups:read&redirect_uri=...&state=..." }
```

### Disconnect Slack

```
DELETE /integrations/slack
```

**Required role:** `admin`

Disconnects the Slack integration. Clears `slackChannelId` and `slackChannelName` from all detections and correlation rules.

**cURL example**

```bash
curl -s -b cookies.txt -X DELETE http://localhost:4000/integrations/slack \
  -H "X-Sentinel-Request: 1"
```

### Search Slack channels

```
GET /integrations/slack/channels?q=search-term
```

Searches Slack channels by name. Requires at least 2 characters in the `q` parameter.

**cURL example**

```bash
curl -s \
  -b cookies.txt \
  "http://localhost:4000/integrations/slack/channels?q=security"
```

**Response:**

```json
{
  "channels": [
    { "id": "C01234ABC", "name": "security-alerts", "isPrivate": false },
    { "id": "C05678DEF", "name": "security-ops", "isPrivate": true }
  ]
}
```

### Resolve Slack channel

```
GET /integrations/slack/channels/:channelId
```

Resolves a Slack channel ID to its name and privacy status.

**cURL example**

```bash
curl -s \
  -b cookies.txt \
  "http://localhost:4000/integrations/slack/channels/C01234ABC"
```

---

## Module webhook routes

Each module registers routes under `/modules/<moduleId>`. These routes handle incoming webhooks and module-specific operations. Authentication for webhook paths (containing `/webhooks/`, `/callback`, or `/ci/notify`) is handled by module-specific verification (e.g., GitHub webhook signatures, notify keys) rather than session or API key auth.

All other `/modules/*` routes require authentication and organisation membership.

---

## Module templates

Each module exposes a list of `DetectionTemplate` objects that describe pre-built detection configurations users can instantiate without writing rule configs by hand. Templates are surfaced through the `GET /api/detections/resolve-template` and `POST /api/detections/from-template` endpoints rather than directly through the modules metadata endpoint. See [detections.md](./detections.md) for template-related endpoints.

### DetectionTemplate object

| Field | Type | Description |
|-------|------|-------------|
| `slug` | `string` | URL-safe identifier (e.g., `github-repo-visibility`). Use as `templateSlug` in detection endpoints. |
| `name` | `string` | Human-readable template name shown in the UI. |
| `description` | `string` | Description of what the template detects. |
| `category` | `string` | UI grouping category (e.g., `access-control`, `code-protection`, `secrets`). |
| `severity` | `"low" \| "medium" \| "high" \| "critical"` | Default severity for detections instantiated from this template. |
| `rules` | `TemplateRule[]` | Rule definitions used to populate detection rules. |
| `inputs` | `TemplateInput[]` | User-configurable fields rendered as a form. |

### TemplateInput object

| Field | Type | Description |
|-------|------|-------------|
| `key` | `string` | Config key. Replaces `{{key}}` placeholders in rule configs. |
| `label` | `string` | Human-readable field label. |
| `type` | `string` | Input control type: `text`, `number`, `boolean`, `select`, `string-array`, `address`, `contract`, `network`. |
| `required` | `boolean` | Whether the input must be provided. |
| `default` | `unknown` | Default value pre-filled in the form. |
| `placeholder` | `string` | Input placeholder text. |
| `help` | `string` | Helper text shown below the field. |
| `options` | `{ label: string; value: string }[]` | Options for `select` type inputs. |
| `min` | `number` | Minimum value for `number` type. |
| `max` | `number` | Maximum value for `number` type. |
| `showIf` | `string` | Key of another input. This field is only shown when the referenced input has a non-empty value. |

---

## Dynamic UI generation

The modules metadata endpoints support fully dynamic UIs that require no module-specific client code.

**Recommended flow for building a "Create Correlation Rule" form:**

1. Call `GET /api/modules/metadata` to populate module and event-type selectors.
2. When a user selects a `moduleId` and `eventType` for a step filter, call `GET /api/modules/metadata/sample-fields?moduleId=...&eventType=...` to populate field-path autocomplete.
3. Build the `config` object from the user's form values and submit to `POST /api/correlation-rules`.

**Recommended flow for building a "Create Detection from Template" form:**

1. Call `GET /api/detections/resolve-template?moduleId=...&slug=...` to retrieve the template's `inputs` array.
2. Render a form field for each `TemplateInput` entry.
3. Collect user values into an `inputs` map and submit to `POST /api/detections/from-template`.
