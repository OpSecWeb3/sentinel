# Using detection templates

Detection templates are pre-built rule configurations that address common security
monitoring scenarios. Each template bundles one or more evaluation rules with
sensible defaults, so you can deploy a detection in minutes without writing rules
from scratch.

Templates are organized by **module** (the data source they monitor) and
**category** (the security domain they address). When you create a detection from
a template, Sentinel provisions the underlying rules, connects them to your
notification channels, and begins evaluation immediately.

## What templates are

A template is a reusable blueprint that defines:

- One or more **evaluation rules** with default configurations.
- A **severity** level appropriate for the threat scenario.
- A set of **inputs** -- parameters you fill in to customize the template for your
  environment (for example, a contract address, a token threshold, or a branch
  name pattern).
- A **category** that groups related templates within a module (for example,
  "access-control" or "governance").

When you create a detection from a template, Sentinel resolves the template
inputs, generates the concrete rules, and stores them as a standard detection.
You can edit the detection later to change any parameter, and Sentinel rebuilds
the rules from the template definition with your updated inputs.

## Browsing available templates by module

Navigate to **Detections** in the sidebar, then select **+ New Detection**. The
template picker displays five module tabs across the top of the page:

| Module tab | Data source | Description |
|---|---|---|
| **github** | GitHub webhook events | GitHub security detection templates covering access control, code protection, secrets, and organization management. |
| **infra** | TLS, DNS, WHOIS, HTTP probes | Infrastructure monitoring templates for certificates, DNS records, domain registration, and host availability. |
| **chain** | EVM-compatible blockchains | On-chain detection templates for token activity, balance monitoring, governance events, and custom contract monitoring. |
| **registry** | Docker registries, npm | Supply chain security templates for container image and npm package monitoring. |
| **aws** | AWS CloudTrail | AWS CloudTrail detection templates organized by MITRE ATT&CK categories: identity, defense evasion, network, data, compute, and reconnaissance. |

Select a module tab to load its templates. Each module organizes templates into
categories.

### Filtering by category

For modules with predefined categories (github, aws), category buttons appear
below the module tabs. Select a category to filter the template list. Select
**all** to show every template in the module.

The github module uses these categories: `access-control`, `code-protection`,
`secrets`, `organization`, and `comprehensive`.

The aws module uses these categories: `identity`, `defense-evasion`, `network`,
`data`, `compute`, `reconnaissance`, and `comprehensive`.

For other modules (chain, infra, registry), categories are derived dynamically
from the loaded templates.

### Searching templates

The chain module provides a search bar for finding templates by name or
description. Type a query and Sentinel filters the results after a short delay.
Other modules use category filtering instead of search.

## Creating a detection from a template

Follow these steps to create a detection from a template.

1. Navigate to **Detections** in the sidebar, then select **+ New Detection**.
2. Select the module tab at the top of the page (**github**, **infra**, **chain**,
   **registry**, or **aws**).
3. Optionally filter templates by category or use the search bar (chain module
   only).
4. Review the template cards. Each card shows the template name, default severity,
   category, rule count, and any required inputs.
5. Select a template card to proceed to the configuration form.
6. On the configuration form, provide values for all fields marked with a red
   asterisk (*). These are required inputs.
7. Optionally customize the **name** field. Sentinel pre-fills the template name.
8. Select a **severity** level from the dropdown (`critical`, `high`, `medium`,
   or `low`). The template's default severity is pre-selected.
9. Set the **cooldown (min)** value. This controls the minimum time between
   repeated alerts. The default is 5 minutes. The maximum is 1440 minutes (24
   hours). Set to 0 for no cooldown.
10. Select **Create Detection**. Sentinel provisions the detection and its rules,
    validates any prerequisite resources, and redirects you to the detection detail
    page. Evaluation begins immediately.

If prerequisite resources are missing (for example, no active GitHub App
installation for a GitHub detection, or no monitored hosts for an infrastructure
detection), Sentinel returns an error message explaining what to set up first.

## Customizing template parameters

Templates provide default values for most parameters, but you can override any
value during creation or later through the edit page.

### Overriding severity

The detection inherits the template's severity by default. To change it, select a
different value from the **severity** dropdown on the configuration form.

### Adjusting thresholds

Many templates expose numeric inputs such as transfer thresholds, time windows,
and percentage drop limits. Enter your own values to match your operational
requirements. For number inputs, the template may specify minimum and maximum
constraints.

### Scoping by resource

Different modules use different resource scoping mechanisms:

- **Blockchain templates** require you to select a **network** and optionally a
  **contract address**. When you select a contract, Sentinel auto-fills the
  network. If you leave the contract field empty on templates where it is
  optional, the detection monitors all contracts on the selected network.
- **Infrastructure templates** provide a **host scope** field where you enter
  comma-separated hostnames or glob patterns (for example,
  `api.example.com, *.prod.example.com`). Leave the field empty for
  organization-wide monitoring.
- **Registry templates** provide an **artifact** dropdown where you select a
  specific monitored Docker image or npm package. Sentinel loads your registered
  artifacts automatically.

### Conditional inputs

Some template inputs only appear when a prerequisite input has a value. For
example, a contract filter may only appear after you select a network. These
conditional inputs use the `showIf` property to control visibility.

### String array inputs

Some inputs accept multiple values, such as a list of addresses or branch
patterns. Enter one value per line, or use comma-separated values. Sentinel
parses both formats.

### Changing rule actions after creation

Each template rule has a default action of `alert`, `log`, or `suppress`. After
creating the detection, you can edit individual rules through the detection edit
page to change their action. For example, you might change an alerting rule to
`log` during an initial tuning period.

## Example: setting up a "suspicious transfer" template for blockchain

This example demonstrates creating a detection that alerts on large ERC-20
token transfers.

1. Navigate to **Detections** > **+ New Detection**.
2. Select the **chain** tab.
3. In the search bar, type "transfer" to filter templates.
4. Select the **Large Transfer Monitor** card. The card shows severity `high`,
   category `token-activity`, and lists required inputs: network, contract
   address, and threshold.
5. On the configuration form:
   - **Name**: Enter "Treasury USDC large transfer alert" or keep the default.
   - **Severity**: Select `critical` (upgrading from the default `high` because
     this monitors a treasury contract).
   - **Cooldown**: Set to `15` minutes to avoid repeated alerts during a batch
     transfer session.
   - **Network**: Select your target network from the dropdown (for example,
     "Ethereum Mainnet (chainId: 1)").
   - **Contract**: Select the USDC contract from the dropdown, or leave empty to
     monitor all contracts on the selected network.
   - **Threshold**: Enter the token amount that constitutes a "large" transfer
     (for example, `1000000` for 1 million tokens in base units).
6. Select **Create Detection**.

Sentinel creates the detection with rules configured to monitor Transfer events
on the specified contract and alert when the transfer amount exceeds your
threshold.

## Example: setting up a "repo made public" template for GitHub

This example demonstrates creating a detection that alerts when a repository in
your GitHub organization is made public.

1. Navigate to **Detections** > **+ New Detection**.
2. Select the **github** tab.
3. Select the **access-control** category.
4. Select the **Repository Visibility Monitor** card. The card shows severity
   `critical` and lists the template description.
5. On the configuration form:
   - **Name**: Enter "Production org repo visibility alert" or keep the default.
   - **Severity**: Keep as `critical`. A repository becoming public is a high-risk
     event.
   - **Cooldown**: Set to `0` minutes. This event is rare, and you want an alert
     every time it occurs.
   - Fill in any required template inputs. For the visibility monitor, you may
     need to specify which visibility change to watch for (typically
     "publicized").
6. Select **Create Detection**.

Sentinel creates the detection and begins monitoring your GitHub organization's
webhook events. When any repository is made public, the detection fires and sends
notifications to all assigned channels.

To receive notifications, assign at least one notification channel to the
detection. You can do this during creation or by editing the detection afterward.
See [Configuring notification channels](../alerts/configuring-channels.md) for
instructions.

## Available templates by module

### Blockchain (chain)

The blockchain module monitors on-chain activity across EVM-compatible networks.
Templates are grouped into the following categories.

**Token activity**

| Template | Severity | Description |
|---|---|---|
| Large Transfer Monitor | High | Alert when an ERC-20 Transfer event moves more than a specified token amount. |
| Repeated Transfer Detector | High | Alert when the same recipient receives more than a threshold number of transfers within a time window. |
| Transfer Volume Monitor | High | Alert when cumulative transfer volume exceeds a threshold within a rolling window. |

**Balance**

| Template | Severity | Description |
|---|---|---|
| Fund Drainage Detection | Critical | Alert when a contract balance drops by a percentage within a time window. Combines transfer counting with balance tracking. |
| Balance Low Alert | Medium | Alert when native or token balance falls below a minimum threshold. |
| Balance Tracker | Medium | Monitor balance with configurable conditions: minimum, maximum, or percentage change. |
| Native Balance Anomaly | High | Alert when native (ETH/MATIC) balance drops by a configurable percentage. |

**Governance**

| Template | Severity | Description |
|---|---|---|
| Contract Ownership Monitor | Critical | Alert on OwnershipTransferred and OwnershipTransferStarted events (OpenZeppelin patterns). |
| Storage Anomaly Detector | High | Monitor an EVM storage slot for unexpected changes or threshold crossings. |
| Access-Control Role Change | High | Alert when AccessControl roles are granted or revoked. |
| Proxy Upgrade Monitor | Critical | Alert on ERC-1967 Upgraded events. |
| Proxy Upgrade Slot Watcher | Critical | Poll the ERC-1967 implementation storage slot for changes, even when events are suppressed. |
| Multisig Signer Change | High | Alert when owners are added to or removed from a Safe (Gnosis Safe) wallet. |
| Pause State Monitor | High | Alert when a contract is paused or unpaused. |

**Contract activity**

| Template | Severity | Description |
|---|---|---|
| Contract Creation Watcher | High | Alert when a monitored address deploys a new contract. |

**Custom**

| Template | Severity | Description |
|---|---|---|
| Custom Event Monitor | Medium | Watch for any on-chain event by Solidity signature with optional parameter filters. |
| Custom Function Call Monitor | High | Alert when a specific function is called by matching the 4-byte selector in calldata. |
| Custom Storage Slot Monitor | Medium | Poll an arbitrary storage slot and alert on a user-defined condition. |
| Custom View Function Monitor | Medium | Call a read-only function on a schedule and alert on the returned value. |
| Custom Windowed Event Count | Medium | Count event occurrences in a sliding window and alert above a threshold. |
| Activity Spike Detector | High | Alert when event firing rate increases dramatically compared to a baseline period. |

### GitHub

The GitHub module processes webhook events from your GitHub organization.
Categories include access control, code protection, secrets, and organization
management.

| Template | Category | Severity | Description |
|---|---|---|---|
| Repository Visibility Monitor | Access control | Critical | Alert when a repository is made public. |
| Member Access Monitor | Access control | High | Alert on member additions and removals. |
| Deploy Key Monitor | Access control | High | Alert when deploy keys are added, especially write-access keys. |
| Branch Protection Changes | Code protection | High | Alert when branch protection rules are modified or removed. |
| Force Push Detection | Code protection | Critical | Alert on force pushes to critical branches. |
| Secret Scanning Alerts | Secrets | Critical | Alert when GitHub detects exposed secrets. |
| Organization Settings Monitor | Organization | High | Alert on organization and team changes. |
| Full GitHub Security Suite | Comprehensive | Critical | All GitHub monitors in a single detection. |

### Registry

The registry module monitors Docker image registries and npm package registries
for supply chain threats.

**Container security**

| Template | Severity | Description |
|---|---|---|
| Docker Image Monitor | Medium | Alert on digest changes, new tags, and tag removals. |

**Supply chain**

| Template | Severity | Description |
|---|---|---|
| Require CI Attribution | High | Alert when a release lacks verified CI attribution. |
| Enforce Signatures | Critical | Alert when a Docker image lacks a cosign signature. |
| Enforce Provenance | Critical | Alert when a release lacks a SLSA provenance attestation. |
| Detect Manual Push | High | Alert when an image is pushed by a user not on the approved allowlist. |
| Pin Digest | Critical | Alert when a Docker image digest changes from a pinned value. |
| Suspicious Activity | High | Alert on rapid changes or off-hours release activity. |
| Detect Source Mismatch | High | Alert when a change is detected by polling but was not preceded by a webhook. |

**Package security**

| Template | Severity | Description |
|---|---|---|
| npm Package Monitor | High | Alert on npm version changes, install scripts, major jumps, and maintainer changes. |
| npm Unpublish Alert | Critical | Alert when an npm version is unpublished. |
| npm Rapid Publish | High | Alert when npm versions are published faster than expected. |
| npm Off-Hours Publish | High | Alert when packages are published outside business hours. |
| npm Tag Audit | Medium | Log npm dist-tag changes matching specific patterns. |
| npm Tag Pin Digest | Critical | Alert when a tarball digest changes from a pinned value. |
| npm Tag Removed | High | Alert when a dist-tag is removed. |
| npm Maintainer Change | High | Alert when maintainers are added or removed. |
| npm Require Provenance | Critical | Alert when a published version lacks SLSA provenance. |
| npm Tag Require CI | High | Alert when a dist-tag change is not attributed to a verified CI workflow. |
| npm Tag Install Scripts | Critical | Alert when a dist-tag points to a version containing install scripts. |
| npm Tag Require Provenance | Critical | Alert when a dist-tag change points to a version without provenance. |
| npm Tag Major Version Jump | High | Alert when a dist-tag is moved to a version with a major semver increment. |
| npm Tag Rapid Change | High | Alert when dist-tags change faster than expected. |
| npm Tag Off-Hours | High | Alert when dist-tags are changed outside business hours. |

**Comprehensive**

| Template | Severity | Description |
|---|---|---|
| Full Registry Security | Critical | All registry monitors in one detection. |
| Log Releases | Low | Log all release changes without alerting. |
| npm Log Releases | Low | Log all npm publish and unpublish events. |

### Infrastructure (infra)

The infrastructure module monitors TLS certificates, DNS records, domain
registration, and host availability.

| Template | Category | Severity | Description |
|---|---|---|---|
| Certificate Monitor | Certificate | Critical | Alert on expiring certificates and certificate issues. |
| TLS Security | TLS | High | Alert on TLS weaknesses and missing security headers. |
| DNS Change Monitor | DNS | High | Alert on DNS record changes and new subdomains. |
| Host Uptime | Availability | Critical | Alert when a host becomes unreachable or responds slowly. |
| Domain Expiry Monitor | DNS | High | Alert when a domain registration approaches expiry. |
| Certificate Transparency Monitor | DNS | Medium | Alert on new CT log entries for your domain. |
| Full Infrastructure Audit | Comprehensive | Critical | All infrastructure monitors in one detection. |

### AWS

The AWS module processes CloudTrail events to detect identity, network, and data
security threats.

| Template | Category | Severity | Description |
|---|---|---|---|
| Root Account Activity Monitor | Identity | Critical | Alert on any root account API action. |
| Console Login Monitor | Identity | High | Alert on login failures and root console logins. |
| IAM User Changes | Identity | High | Alert on IAM user and access key lifecycle events. |
| IAM Privilege Escalation Detection | Identity | Critical | Alert on policy attachments and inline policy modifications. |
| Federated Identity Role Assumption | Identity | High | Alert on role assumptions via OIDC/SAML. |
| MFA Deactivation Alert | Identity | High | Alert when an MFA device is deactivated. |
| CloudTrail Tampering | Defense evasion | Critical | Alert when CloudTrail logging is stopped or modified. |
| AWS Config Evasion | Defense evasion | Critical | Alert when the Config recorder is stopped or rules are deleted. |
| Security Group Open Ingress | Network | High | Alert when security group ingress rules are added. |
| EC2 SSH Key Pair Changes | Network | High | Alert on new SSH key pair creation or import. |
| Unusual EC2 Instance Launch | Compute | Medium | Alert on instance launches in unexpected regions. |
| Spot Instance Eviction Monitor | Compute | Medium | Alert when spot instances receive an interruption warning. |
| S3 Public Access Changes | Data | Critical | Alert on S3 bucket ACL, policy, and encryption changes. |
| KMS Key Deletion, Disable, or Grant | Data | Critical | Alert on key disable, deletion, or grant creation. |
| Secrets Manager Access Monitor | Data | High | Alert on secret reads and deletions. |
| Access Denied Monitor | Reconnaissance | Medium | Alert on repeated access-denied errors. |
| AWS Full Security Suite | Comprehensive | Critical | All Tier 1 AWS monitors in one detection. |

## Template categories and use cases

| Category | Modules | Use case |
|---|---|---|
| Token activity | Chain | Monitor ERC-20 transfers for whale movements, wash trading, and drip attacks. |
| Balance | Chain | Detect fund drainage, low balances on operational wallets, and unexpected outflows. |
| Governance | Chain | Track ownership transfers, proxy upgrades, role changes, and pause states on critical contracts. |
| Contract activity | Chain | Watch for new contract deployments by monitored addresses. |
| Custom | Chain | Build flexible monitors using event signatures, function selectors, storage slots, and windowed counts. |
| Access control | GitHub | Monitor repository visibility, member changes, and deploy key additions. |
| Code protection | GitHub | Detect branch protection weakening and force pushes. |
| Secrets | GitHub | Respond to exposed secrets detected by GitHub. |
| Organization | GitHub | Track org membership, team permissions, and settings changes. |
| Container security | Registry | Monitor Docker image digest and tag changes. |
| Supply chain | Registry | Enforce CI attribution, signatures, provenance, and detect manual pushes. |
| Package security | Registry | Monitor npm packages for version changes, maintainer changes, and dist-tag mutations. |
| Certificate | Infra | Alert on certificate expiry and certificate chain issues. |
| TLS | Infra | Detect legacy TLS versions, weak ciphers, and missing security headers. |
| DNS | Infra | Monitor DNS record changes, domain expiry, and new subdomain discovery. |
| Availability | Infra | Alert on host unreachability and slow responses. |
| Identity | AWS | Detect root account usage, IAM changes, privilege escalation, and console anomalies. |
| Defense evasion | AWS | Alert on CloudTrail and Config tampering. |
| Network | AWS | Monitor security group changes and SSH key pair lifecycle. |
| Data | AWS | Detect S3 exposure, KMS key abuse, and secrets access. |
| Compute | AWS | Alert on unusual EC2 launches and spot evictions. |
| Reconnaissance | AWS | Detect access-denied patterns that indicate permission enumeration. |
| Comprehensive | All | All-in-one detections that enable every monitor in a module with a single deployment. |
