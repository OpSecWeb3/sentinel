# Security Policy

Sentinel takes security issues seriously. If you discover a vulnerability, please report it privately so we can investigate and patch it before public disclosure.

## Supported Versions

Security fixes are currently provided for:

| Version | Supported |
| --- | --- |
| `main` (latest) | Yes |
| Older commits/tags | No (best effort only) |

If you are running a fork or an older deployment, upgrade to the latest `main` before opening a security report.

## Reporting a Vulnerability

**Do not open public GitHub issues for vulnerabilities.**

Use one of these private channels:

1. **Preferred:** GitHub Security Advisories (private report in this repository)
2. **Email:** [security@sentinel.dev](mailto:security@sentinel.dev)

If you are unsure whether an issue is security-sensitive, report it privately first.

## What to Include in Your Report

Please include as much of the following as possible:

- A clear description of the issue and impacted component(s)
- Reproduction steps (HTTP requests, payloads, CLI commands, or proof-of-concept)
- Preconditions (auth role, API key scope, deployment mode, env assumptions)
- Impact assessment (data exposure, privilege escalation, RCE, DoS, integrity impact)
- Suggested fix or mitigations (optional but appreciated)
- Your preferred disclosure/credit name

Please redact secrets, tokens, private keys, and personal data from reports.

## Response and Remediation Targets

We will acknowledge valid reports quickly and keep you updated during triage and remediation.

| Severity | Initial Acknowledgement | Triage Target | Remediation Target |
| --- | --- | --- | --- |
| Critical | 24 hours | 72 hours | 7 days |
| High | 2 business days | 5 business days | 14 days |
| Medium | 3 business days | 10 business days | Next scheduled release |
| Low | 5 business days | 15 business days | Backlog / hardening cycle |

Targets are goals, not strict guarantees. Complex fixes may require longer timelines.

## Coordinated Disclosure

- We follow coordinated disclosure by default.
- Please allow reasonable time for patching and verification before public disclosure.
- Unless otherwise agreed, our default maximum disclosure window is **90 days** from acknowledgement.
- Once a fix is released, we may publish a security advisory with impact, affected versions, and upgrade guidance.

## Safe Harbor for Security Research

We support good-faith security research. We will not pursue legal action for accidental, minimal-impact testing that follows this policy.

Allowed testing guidelines:

- Test only systems you are authorized to test
- Avoid privacy violations, data destruction, and service disruption
- Do not exfiltrate or retain non-public data beyond what is necessary to prove impact
- Do not use social engineering, phishing, or physical attacks
- Do not run high-volume or denial-of-service testing against production systems

If a test unintentionally accesses sensitive data, stop immediately and report it.

## Out of Scope

The following are generally out of scope unless a practical exploit is shown:

- Missing best-practice headers without demonstrable impact
- Self-XSS requiring unrealistic user interaction
- Rate-limit bypass claims without reproducible abuse path
- Vulnerabilities only present in unsupported versions
- Known issues in third-party dependencies without a reachable exploit path in Sentinel

## Dependency and Supply-Chain Issues

If your report involves a third-party package vulnerability:

- Include the package name, affected version, and advisory/CVE reference
- Show exploitability in Sentinel's runtime context
- Include affected workspace(s): `apps/*`, `packages/*`, or `modules/*`

## Credit and Recognition

With your permission, we are happy to acknowledge responsible reporters in release notes or advisories.

## Security Maintenance Practices

Sentinel performs continuous security checks in CI and scheduled workflows, including:

- Secret scanning
- Dependency vulnerability scanning
- Filesystem/package/IaC scanning

For implementation details, see `docs/security-scanning.md`.
