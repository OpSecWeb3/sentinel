# Glossary

This glossary defines terms used throughout the Sentinel documentation. Terms are listed alphabetically.

---

## Sentinel concepts

**Absence (correlation)**
An absence is a correlation rule type that fires when a trigger event occurs but an expected follow-up event does not arrive within a configured grace period. For example, an absence rule can alert when a deployment event occurs but no health check event follows within 10 minutes. The correlation engine stores absence timers in Redis and checks for expiration every 5 minutes.

**Alert**
An alert is a record generated when a detection rule or correlation rule evaluates an incoming event and the conditions are met. Each alert contains the triggering event, the severity level, a description, and the notification status (pending, sent, or failed). Alerts are the primary output that Sentinel delivers to your notification channels.

**API Key**
An API key is a credential that grants programmatic access to the Sentinel API on behalf of a specific user and organization. Each key carries one or more permission scopes (`api:read` or `api:write`), an optional expiry date, and a short identifying prefix (for example, `sk_abc123`). The full key value is shown only once at creation; Sentinel stores only a hash.

**Artifact**
An artifact is a software package or container image that the Registry module monitors. Each artifact has a name, a registry source, and a history of observed versions. The Registry module polls for new artifact versions and evaluates them for security-relevant changes such as digest changes, anomalous publishing patterns, or missing signatures.

**Audit Log**
The audit log is an immutable, time-ordered record of all administrative actions taken within a Sentinel organization. It records who performed each action, what resource was affected, and when, providing a chain of evidence for compliance reviews and incident investigations.

**AWS Module**
The AWS module monitors AWS cloud infrastructure by polling Amazon SQS queues for CloudTrail events and other AWS service notifications. It normalizes AWS events into the Sentinel event format and evaluates them using module-specific evaluators. The module polls every 60 seconds and requires AWS credentials configured as an organization integration.

**Block Cursor**
A block cursor is a pointer that tracks the last processed block number for each blockchain network monitored by the Chain module. The block poller advances the cursor as it processes new blocks, ensuring that no block is skipped or processed twice after a restart. Block cursors are stored in PostgreSQL.

**Chain Module**
The Chain module monitors Ethereum-compatible blockchain networks for on-chain events such as contract interactions, token transfers, and governance actions. It uses configurable JSON-RPC endpoints to poll for new blocks and emits events to the detection engine for evaluation. The module supports multiple networks and provides evaluators for balance tracking, function call matching, state polling, windowed counts, windowed spikes, and windowed sums.

**Channel**
A channel (also called a notification channel) is a configured destination where Sentinel delivers alert notifications. Supported channel types include Slack, webhooks, and email. Each channel belongs to an organization and can be assigned to one or more detections or correlation rules. See also **Notification Channel**.

**Cooldown**
Cooldown is a per-detection or per-correlation-rule setting that prevents repeated firing within a specified time window (in minutes). After a detection triggers an alert, a cooldown lock is set in Redis (with a PostgreSQL fallback). During the cooldown period, matching events are received but no new alert is generated. Cooldown is scoped per rule and optionally per resource ID.

**Correlation Engine**
The correlation engine is the component that evaluates multi-event patterns across time windows. Unlike the detection engine, which evaluates each event in isolation, the correlation engine tracks sequences, aggregations, and absences of events across one or more modules. It maintains in-flight correlation state in Redis and generates correlated alerts when a pattern is fully matched.

**Correlation Key**
A correlation key is a set of one or more payload fields that the correlation engine uses to group events into the same logical bucket. Events are linked when they share the same values for all configured correlation key fields. The engine computes a SHA-256 hash of the key field values to identify each bucket. If any required key field is missing from an event, the event is skipped for that rule.

**Correlation Rule**
A correlation rule defines a multi-event pattern that the correlation engine evaluates. Sentinel supports three types: **sequence** (an ordered set of events must occur within a time window), **aggregation** (a threshold count of matching events within a window), and **absence** (a trigger event must occur but an expected follow-up must not). Each rule has a correlation key, a window duration, a severity, and optional notification channels.

**Cross-step Condition**
A cross-step condition is a constraint within a sequence correlation step that compares a field in the current event against a field captured from a previous step. Cross-step conditions use `==` or `!=` operators and are evaluated using dot-notation field paths (for example, `steps.ProtectionDisabled.sender.login`). All cross-step conditions on a step must pass for the step to match.

**Detection**
A detection is a configured monitoring rule that defines what Sentinel watches for and what to do when it finds it. Each detection belongs to a module, has a severity level, one or more notification channels, an optional cooldown, and one or more rules that define the matching logic. Detections can be created from templates or configured manually.

**Detection Engine**
The detection engine is the component of the worker service that evaluates events against active detection rules. When an event arrives, the engine finds all active rules for the corresponding organization and module, runs each evaluator in priority order, and generates alert candidates for rules whose conditions are satisfied. The engine also handles suppress and log actions.

**Digest**
A digest is a cryptographic hash (typically SHA-256) that uniquely identifies a specific version of a software artifact. The Registry module's digest-change evaluator compares the digest of a newly published package version against expected values to detect unauthorized modifications or supply-chain attacks.

**Evaluator**
An evaluator is the code that implements the matching logic for a specific rule type within a module. Each evaluator declares a `moduleId` and `ruleType`, validates the rule configuration against a Zod schema, and returns an alert candidate if the event matches. Evaluators are registered at worker startup. If a detection references a rule type with no registered evaluator, the rule is silently skipped.

**Event**
An event is a normalized record of an activity observed by a Sentinel module. Each event has a module ID, an event type, a timestamp (`occurredAt`), an organization ID, and a payload containing the raw fields from the source system. Events are stored in PostgreSQL and evaluated by both the detection engine and the correlation engine.

**Event Filter**
An event filter is a set of criteria used within a correlation rule step to determine whether an incoming event matches that step. An event filter can specify a module ID, one or more event types, and an array of field conditions (using operators such as `==`, `!=`, `>`, `<`, `>=`, `<=`). Event filters are evaluated using AND logic across all conditions.

**Event Type**
An event type is a string that classifies what happened within a module. For example, the GitHub module uses event types such as `push`, `pull_request`, and `repository.vulnerability_alert`. Detection rules target one or more event types, so the event type determines which rules are evaluated against an incoming event.

**GitHub App**
A GitHub App is the authentication mechanism the GitHub module uses to receive webhooks and access the GitHub API. You register a GitHub App in your GitHub organization, configure it with Sentinel's webhook URL and secret, and provide the app credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`) to Sentinel. The GitHub module also supports OAuth via `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`.

**Host**
A host is an internet-facing asset registered in the Infrastructure module, typically a domain name or hostname. The Infrastructure module monitors hosts for security properties such as CDN proxy status, TLS certificate expiry, and WHOIS domain expiry. Each host is scoped to an organization.

**Infrastructure Module**
The Infrastructure module monitors internet-facing infrastructure assets. It provides evaluators for certificate expiry, WHOIS domain expiry, and CDN score degradation. These evaluators run on a polling schedule and alert when a monitored property crosses a configured threshold.

**Instance (correlation)**
A correlation instance is the in-flight state for a partially matched correlation rule. For sequence rules, an instance tracks which steps have been completed, the correlation key hash, timestamps of matched events, and the expiration time. Instances are stored in Redis with a TTL matching the correlation window. When all steps complete, the instance triggers an alert and is deleted.

**Module**
A module is a self-contained integration that connects Sentinel to an external data source or security domain. Each module provides event ingestion logic, a set of rule evaluators, detection templates, optional job handlers for background tasks, and optional retention policies. The current modules are GitHub, Registry, Chain, Infrastructure, and AWS. Modules are registered in both the API (for routing) and the worker (for evaluation).

**Notification Channel**
A notification channel is a configured destination for alert notifications. Supported types include Slack (via OAuth bot token), webhook (HTTP POST to a URL), and email (via SMTP). Each channel belongs to an organization. A detection or correlation rule can reference multiple channels. See also **Channel**.

**Notification Delivery**
A notification delivery is a record of an attempt to send an alert notification through a channel. Each delivery tracks the alert ID, the channel, the HTTP status code (for webhook and Slack channels), any error message, and the delivery status. Delivery records are stored in PostgreSQL and are visible in the dashboard.

**Notify Key**
A notify key is an organization-level credential used to authorize event ingestion from module polling pipelines and certain push paths. It is distinct from user API keys and from the webhook secret. Modules that poll external systems (such as the Registry module polling npm) use the notify key to authenticate their ingestion requests. The key is shown once at generation and stored only as a hash.

**Organization**
An organization is the top-level tenant boundary in Sentinel. All users, detections, events, alerts, integrations, and credentials belong to an organization. Each organization has a unique name, a URL-safe slug, an invite secret, a webhook secret, and a notify key.

**Organization Membership**
An organization membership is the association between a user and an organization, along with the user's role within that organization. Roles determine what actions a user can perform (see **Role**). A user can belong to one organization at a time in the current model.

**Polling**
Polling is the event ingestion method used by modules that cannot receive push-based webhooks. The worker schedules repeatable BullMQ jobs that periodically query external systems for new data. The Registry module polls npm every 60 seconds, the AWS module polls SQS every 60 seconds, and the Chain module polls blockchain RPCs on a per-network schedule.

**Priority**
Priority is a numeric value on a detection rule that determines the order in which rules are evaluated. Rules are evaluated in ascending priority order (lowest number first). A suppress rule with a lower priority number is evaluated before an alert rule with a higher priority number, allowing you to define exceptions that prevent alerts from firing.

**Registry Module**
The Registry module monitors open-source software package registries (specifically npm) for security-relevant events. It polls for new package versions, verifies package signatures using Sigstore, and detects suspicious publishing patterns. The module provides evaluators for anomaly detection, attribution checks, digest changes, and npm-specific checks.

**Resource Filter**
A resource filter is a rule-level configuration that restricts which resources (identified by `resourceId` in the event payload) a rule evaluates. A resource filter supports `include` and `exclude` arrays of glob patterns. Exclude patterns take precedence: if a resource matches any exclude pattern, the rule is skipped even if the resource also matches an include pattern.

**Role (RBAC)**
A role determines a user's permissions within an organization. Sentinel uses role-based access control (RBAC) to restrict which API endpoints a user can access. The session stores the user's role, and the `requireAuth` and `requireOrg` middleware functions enforce access based on the role value.

**Rule**
A rule is a single condition set within a detection that defines matching logic for a specific event type. Each rule has a type (which determines which evaluator handles it), a configuration object, a priority, an action (`alert`, `log`, or `suppress`), and a status. A detection can contain multiple rules evaluated in priority order. If a suppress rule matches, further evaluation stops and no alert is generated.

**Rule Engine**
The rule engine is the class (`RuleEngine`) that orchestrates detection evaluation. It loads active rules for an organization and module, resolves the appropriate evaluator for each rule, enforces cooldowns (via Redis with a PostgreSQL fallback), checks host scope and resource filters, and returns alert candidates. The rule engine does not write to the database directly; the caller handles persistence.

**Scope (API key)**
A scope is a permission granted to an API key. Sentinel supports `api:read` (read-only access to API endpoints) and `api:write` (read and write access). When authenticating with an API key, the scope determines which operations the key can perform.

**Session**
A session is a server-side authentication state that identifies a logged-in user. Sessions are stored in the PostgreSQL `sessions` table as encrypted JSONB (AES-256 using the `ENCRYPTION_KEY` environment variable). Each session contains the user ID, organization ID, and role. The session cookie (`sentinel.sid`) is HTTP-only, secure (in non-development environments), and SameSite=Lax with a 7-day maximum age.

**Severity**
Severity is a label that classifies how critical an alert is. Sentinel uses four levels: `critical`, `high`, `medium`, and `low`. Severity is set on the detection or correlation rule and propagated to all alerts it generates.

**Slack Installation**
A Slack installation is the record of a completed Slack OAuth flow that grants Sentinel permission to post messages to a Slack workspace. The installation stores the bot token (encrypted at rest), the team ID, and the team name. The bot token is used by the alert dispatch handler to post alert notifications to Slack channels. If the token is revoked, the installation must be re-authorized.

**Snapshot**
A snapshot is a point-in-time record of an on-chain state value captured by the Chain module's state poll evaluator. Snapshots are stored in PostgreSQL and compared across polls to detect state changes. Each snapshot is associated with a network, a contract address, and a method signature.

**State Poll**
A state poll is an evaluator type in the Chain module that periodically reads a value from a smart contract (by calling a view function via JSON-RPC) and compares it against a previous snapshot. If the value changes, the evaluator fires an alert. State polls are useful for monitoring governance parameters, ownership changes, or configuration values on-chain.

**Template**
A template is a pre-built detection configuration provided by a module. Templates package common detection patterns with sensible defaults, clearly defined input fields, and documentation. You can create a detection from a template in the **Detections > New** page, which pre-fills the detection configuration and allows you to customize it before saving.

**Webhook**
A webhook is an HTTP callback that an external system (such as GitHub) sends to Sentinel when an event occurs. Sentinel exposes webhook endpoints under `/modules/<moduleId>/webhooks/`. Payloads are authenticated using an HMAC signature computed with the webhook secret configured in organization settings.

**Window (correlation)**
A window is the time period (in minutes) within which all events in a correlation rule must occur for the rule to fire. For sequence rules, all steps must complete within the window. For aggregation rules, the threshold count must be reached within the window. When the window expires, any in-flight correlation state is discarded.

**Worker**
The worker is the Sentinel background processing service. It connects to Redis via BullMQ and processes jobs from four queues: `events` (rule evaluation, concurrency 15), `alerts` (notification dispatch, concurrency 15), `module-jobs` (module-specific polling and tasks, concurrency 10), and `deferred` (scheduled maintenance tasks, concurrency 5). The worker registers all module evaluators at startup and runs scheduled jobs including daily data retention, hourly session cleanup, and 5-minute sweeps for key rotation, correlation expiry, and RPC usage flushing.

---

## Technology terms

**BullMQ**
BullMQ is a Node.js job queue library built on Redis. Sentinel uses BullMQ to distribute work between the API and worker services. All background processing is implemented as BullMQ jobs placed on named queues and consumed by the worker. Jobs are retried up to 3 times with exponential backoff (2-second base delay). Completed jobs are retained (200 per queue) and failed jobs are retained (500 per queue) for inspection.

**Drizzle ORM**
Drizzle ORM is a TypeScript-first SQL query builder and schema manager. Sentinel uses Drizzle to define all database tables (in the `packages/db/schema` directory), run migrations, and construct type-safe database queries throughout the API and worker services.

**EVM**
EVM (Ethereum Virtual Machine) is the computation environment used by Ethereum and compatible blockchain networks to execute smart contracts. The Sentinel Chain module monitors EVM-compatible networks by reading block data and events through JSON-RPC endpoints.

**Hono**
Hono is a lightweight web framework for TypeScript and Node.js. Sentinel uses Hono for the API service to define HTTP routes, apply middleware (session authentication, API key authentication, RBAC, CSRF defense, rate limiting, request validation), and handle request/response processing.

**Pino**
Pino is a low-overhead structured JSON logging library for Node.js. Both the API and worker services use Pino to emit structured log lines with fields such as `service`, `requestId`, `queue`, `jobName`, and `level`. See the [Log locations](troubleshooting/log-locations.md) page for details on interpreting Pino output.

**PostgreSQL**
PostgreSQL is the relational database used by Sentinel for all persistent data: users, organizations, sessions, API keys, detections, rules, events, alerts, notification channels, audit logs, correlation rules, and module-specific tables. The worker connects with a pool of up to 20 connections. Sessions are stored encrypted in the `sessions` table and expire after 7 days; an hourly cleanup job purges expired rows.

**Redis**
Redis is the in-memory data store used by Sentinel for job queues (BullMQ), rate limiting (atomic Lua counters), cooldown locks (SET NX PX), and correlation state (sequence instances, aggregation counters, absence timers, sorted set indexes). Each BullMQ worker gets its own dedicated Redis connection to avoid head-of-line blocking.

**Sigstore**
Sigstore is an open-source project for signing, verifying, and auditing software artifacts. The Sentinel Registry module uses Sigstore to verify cryptographic signatures of npm packages, confirming that a package was published by the attested key holder. Sigstore trust material is initialized at worker startup.

**Viem**
Viem is a TypeScript library for interacting with Ethereum-compatible blockchains. Sentinel's Chain module uses Viem to connect to configured RPC endpoints, read block data, decode event logs, and format on-chain data for evaluation.
