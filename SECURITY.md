# Security policy

## Supported versions

Harbor `0.x` is beta hobby-project software. Until the first tagged release, only
the latest commit on the public default branch receives security fixes. During
beta, only the newest `0.x` release receives fixes; users should expect to upgrade
rather than receive backports. After 1.0, the latest minor release and its
immediately preceding minor release receive security fixes. Critical fixes may
require an immediate upgrade.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private **Report a vulnerability** flow in the repository's Security tab. Include:

- the affected version or commit;
- deployment mode and relevant non-secret configuration;
- reproduction steps and impact;
- any suggested mitigation; and
- whether the issue is already being exploited.

Do not include live credentials, personal data, database exports, or unredacted
logs. The maintainer will aim to acknowledge a report within seven days, coordinate
a fix and disclosure timeline based on impact, and credit reporters who want
attribution. This is a community target, not a contractual SLA.

## Deployment warning

Harbor remains beta until `1.0`. Proxy authentication must use an explicit proxy
trust list with no route that bypasses the authenticating proxy. Follow the written
acceptance rules in
[`guides/VULNERABILITY_POLICY.md`](guides/VULNERABILITY_POLICY.md); hobby-project status
does not relax the security release gates.
