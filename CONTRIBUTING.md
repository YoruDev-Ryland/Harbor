# Contributing to Harbor

Harbor is a single-maintainer hobby project, and practical fixes, sanitized
compatibility reports, documentation improvements, and focused features are
welcome. There is no response-time or merge SLA. For a large change, open a short
proposal first so effort is not spent against an incompatible direction.

Do not use a public issue or pull request for a suspected vulnerability. Follow
[`SECURITY.md`](SECURITY.md). Never submit real API keys, master secrets, `.env`
files, database/JSON backups, private hostnames, personal data, or unredacted logs
and screenshots. Use `.example.test` names and unmistakably synthetic credentials
in fixtures.

## Development checks

Use a supported Node version and install exactly from the lockfile:

```bash
npm ci
npm run ci
npm run test:e2e
```

Changes to container behavior should also run `npm run test:container`. Changes to
the optional SMS relay should run `npm run test:helper`. Before submitting, run
`npm run secrets:scan`; the hosted workflows independently repeat secret,
dependency, license, CodeQL, browser, architecture, and image checks.

Adapter changes must keep the catalog/capability contract accurate, bound and
validate upstream data, avoid logging credentials, and update
[`guides/COMPATIBILITY.md`](guides/COMPATIBILITY.md) with the sanitized upstream version
actually exercised. New dependencies must pass the existing license and
vulnerability policies.

By contributing, you agree that your contribution may be distributed under
Harbor's [MIT License](LICENSE).
