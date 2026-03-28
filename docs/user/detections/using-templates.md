# Using detection templates

Detection templates are pre-built rule configurations that address common security monitoring scenarios. Each template bundles one or more evaluation rules with sensible defaults, so you can deploy a detection in minutes without writing rules from scratch.

Templates are organized by **module** (the data source they monitor) and **category** (the security domain they address). When you create a detection from a template, Sentinel provisions the underlying rules, connects them to your notification channels, and begins evaluation immediately.

## Available templates by module

### Blockchain (chain)

The blockchain module monitors on-chain activity across EVM-compatible networks. Templates are grouped into the following categories.

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

The GitHub module processes webhook events from your GitHub organization. Categories include access control, code protection, secrets, and organization management.

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

The registry module monitors Docker image registries and npm package registries for supply chain threats.

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

The infrastructure module monitors TLS certificates, DNS records, domain registration, and host availability.

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

The AWS module processes CloudTrail events to detect identity, network, and data security threats.

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

## Creating a detection from a template

1. Navigate to **Detections** in the sidebar, then select **New Detection**.
2. Select the module tab at the top of the page (**github**, **infra**, **chain**, **registry**, or **aws**).
3. Optionally filter templates by category using the category buttons, or use the search bar (available for the chain module).
4. Select a template card. The card displays the template name, severity level, category, rule count, and any required inputs.
5. On the configuration form, provide values for all required inputs. Required inputs are listed at the bottom of each template card.
6. Optionally customize the detection name. If you leave it blank, Sentinel uses the template name.
7. Set the **Cooldown** period. This determines the minimum time between repeated alerts from this detection. The default is 5 minutes; the maximum is 1440 minutes (24 hours).
8. Assign one or more **Notification channels** to route alerts to Slack, email, or webhook endpoints.
9. Select **Create Detection**. Sentinel provisions the detection and its rules, and evaluation begins immediately.

## Customizing template defaults

Templates provide default values for most parameters, but you can override any value during creation.

**Overriding severity.** The detection inherits the template's severity by default. To change it, update the severity dropdown on the creation form.

**Adjusting thresholds.** Many templates expose numeric inputs such as transfer thresholds, time windows, and percentage drop limits. Enter your own values to match your operational requirements.

**Scoping by resource.** Blockchain templates require you to select a network and contract address. Infrastructure templates apply to monitored hosts. Use these resource selectors to narrow the detection scope.

**Changing rule actions.** Each template rule has a default action of `alert`, `log`, or `suppress`. After creating the detection, you can edit individual rules to change their action. For example, you might change an alerting rule to `log` during an initial tuning period.

After creation, you can update any detection parameter through the detection detail page. When you edit a template-based detection, Sentinel rebuilds the underlying rules with your new inputs while preserving notification channel assignments and cooldown settings.

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
