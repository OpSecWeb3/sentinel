# Sentinel User Documentation

Welcome to the Sentinel user documentation. This guide is for security analysts, DevSecOps engineers, smart contract developers, and administrators who operate Sentinel to monitor their organization's security posture.

## What Is Sentinel?

Sentinel is a unified security monitoring platform that watches your GitHub organization, EVM-compatible blockchain contracts, cloud infrastructure, package registries, and AWS environments from a single interface. Instead of logging into separate tools to check each domain, Sentinel ingests events from all of them, evaluates those events against your detection rules in real time, and routes alerts to the notification channels of your choice.

Beyond single-event alerting, Sentinel includes a correlation engine that detects multi-step attack patterns spanning multiple security domains. When a code push, a smart contract upgrade, and a suspicious on-chain transaction occur within the same time window and share a common context -- such as the same repository or the same actor -- Sentinel recognizes the sequence as a correlated threat and emits a single, high-context alert rather than three unrelated ones.

## Who This Documentation Is For

This documentation is for security analysts and administrators who use Sentinel through the web UI or API. It explains what Sentinel does and how to configure it. It does not describe the internal architecture, APIs, or deployment configuration in depth. For API reference and infrastructure documentation, see `docs/app/`.

## "I want to..." Quick Navigation

| I want to... | Go to |
|---|---|
| Install Sentinel on my own server | [Installation](getting-started/installation.md) |
| Create my organization and invite my team | [Initial Setup](getting-started/initial-setup.md) |
| Activate my first detection and see an alert | [Your First Detection](getting-started/first-detection.md) |
| Understand how Sentinel works at a high level | [Sentinel Overview](core-concepts/sentinel-overview.md) |
| Learn how detection rules evaluate events | [Detection Engine](core-concepts/detection-engine.md) |
| Understand multi-step correlation rules | [Correlation Engine](core-concepts/correlation-engine.md) |
| Configure Slack, email, or webhook alerts | [Alerting System](core-concepts/alerting-system.md) |
| Connect my GitHub organization | [GitHub App Integration](integrations/github-app.md) |
| Monitor blockchain contracts | [EVM Blockchain Integration](integrations/evm-blockchain.md) |
| Monitor Docker images and npm packages | [Package Registry Integration](integrations/package-registry.md) |
| Connect my AWS account | [AWS Integration](integrations/aws.md) |
| Create detections from templates | [Using Templates](detections/using-templates.md) |
| Write custom detection rules | [Custom Rules](detections/custom-rules.md) |
| Reduce false positives | [Managing False Positives](detections/managing-false-positives.md) |
| Manage organization members and roles | [User Management](administration/user-management.md) |
| Triage and resolve alerts | [Viewing Alerts](alerts/viewing-alerts.md) |
| Troubleshoot a problem | [Common Issues](troubleshooting/common-issues.md) |
| Look up a term | [Glossary](glossary.md) |

## Documentation Map

| Section | Description |
|---|---|
| [Getting Started](getting-started/installation.md) | Install Sentinel, create your organization, and run your first detection. |
| [Core Concepts](core-concepts/sentinel-overview.md) | Understand the mental model: events, detections, correlations, alerts, and notifications. |
| [Integrations](integrations/) | Connect GitHub, AWS, blockchain nodes, and package registries. |
| [Detections](detections/) | Create, edit, and manage detection rules and templates. |
| [Alerts](alerts/) | Understand alert fields, severity levels, lifecycle, and how to triage. |
| [Administration](administration/) | Manage your organization, team members, roles, and API keys. |
| [Troubleshooting](troubleshooting/) | Diagnose and fix common operational issues. |
| [Glossary](glossary.md) | Definitions of key terms used throughout the documentation. |

## Getting Started Quickly

If you want to get up and running as fast as possible, follow this path:

1. [Installation](getting-started/installation.md) -- Stand up the services with Docker Compose.
2. [Initial Setup](getting-started/initial-setup.md) -- Create your organization and invite your team.
3. [Your First Detection](getting-started/first-detection.md) -- Activate a detection from a template and see your first alert.

For conceptual grounding before you configure anything, start with [Sentinel Overview](core-concepts/sentinel-overview.md).
