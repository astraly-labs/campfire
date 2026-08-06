# Security Policy

## Supported versions

Campfire does not have a stable release yet. Security fixes target the current `staging` branch.

## Reporting a vulnerability

Do not open a public issue. [Report the vulnerability privately through GitHub Security Advisories](https://github.com/astraly-labs/campfire/security/advisories/new).

Include the affected commit, concrete impact, minimal reproduction steps, and any suggested mitigation. Never include real provider credentials, production databases, private conversations, or customer code; use synthetic data.

## Trust boundary

Campfire is designed for a small team whose members fully trust one another. It has no RBAC, tenant isolation, or per-user workspace permissions. An admitted teammate being able to view shared conversations, control shared agents, or operate on projects available to the Campfire service is expected behavior, not a vulnerability.

Valid reports include:

- Bypassing the configured authentication or identity allowlist
- Access by a user who was not admitted
- Crossing a configured workspace or network boundary
- Secret or token disclosure
- Unauthenticated command execution
- A dependency or build issue with concrete, reachable impact

The lack of granular permissions between admitted teammates and attacks requiring a malicious host administrator are outside Campfire's security model.
