# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a vulnerability.**

Use GitHub's private reporting: <https://github.com/avchub/avchub-studio/security/advisories/new>. If that is not available to you, open a normal issue containing only the sentence "I would like to report a security issue privately" and no details, and a maintainer will arrange a private channel.

Please include: what an attacker can do, the smallest reproduction you have, and the version or commit you tested.

### What to expect

This project is maintained by one person, so these are honest commitments rather than aspirational ones:

| Stage | Target |
|---|---|
| Acknowledgement that the report was received | 5 working days |
| First assessment (is it a vulnerability, how severe) | 14 days |
| Fix or a written plan with dates | 90 days |

If a report goes unacknowledged past those windows, escalate by opening a public issue that says a security report is awaiting response — without the details.

We will credit you in the advisory and the release notes unless you ask us not to.

## Supported versions

Only the latest released minor version receives fixes. Before 1.0 there is no long-term support branch.

## Scope

In scope: authentication and session handling, the worker gateway and its credential verification, the policy decision endpoint, SQL and command injection, path traversal in media handling, secrets reaching logs or the UI, and privilege escalation across tenants.

Out of scope: anything requiring the attacker to already control the host; vulnerabilities in FFmpeg, PostgreSQL or Node.js themselves (report those upstream); and behaviour of provider plugins, which are supplied by the operator and are not part of this repository.

## Design notes relevant to security

- **Secrets never live in the repository.** The production config loader rejects any value that looks like a credential, and `npm run scan:secrets` fails the build on credential-shaped content in tracked files.
- **The gateway fails closed.** If the policy decision endpoint cannot be reached, the request is refused rather than forwarded.
- **Tenant isolation is enforced in the database** with PostgreSQL row-level security, not only in application code.
- **Passwords are Argon2id**; TOTP secrets are sealed with AES-256-GCM before they reach the database.
- **Worker credentials are stored encrypted at rest** outside the repository, and the store refuses a directory inside the working tree.

## Known limitations

These are deliberate and documented rather than defects, but you should know about them before deploying:

1. The credential store uses Windows DPAPI. On macOS and Linux you must supply your own implementation; there is no cross-platform default yet.
2. This project has not had an external security audit.
3. Provider plugins run in-process with full privileges. Only load plugins you trust.
