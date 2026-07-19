# Support policy

Harbor is community-supported, self-hosted software. There is no uptime or response
SLA. Before requesting help, use a supported deployment from
[`guides/COMPATIBILITY.md`](guides/COMPATIBILITY.md), read the upgrade and backup
runbooks, and reproduce the issue on the newest supported patch release.

Use GitHub Discussions for configuration questions and GitHub Issues for
reproducible defects or feature requests. Include the Harbor version and schema
shown in Harbormaster, deployment mode, browser, Docker/Compose versions, relevant
sanitized logs, and clear reproduction steps. Never attach `.env` files, database
or JSON backups, master secrets, API tokens, real email/phone values, or calendar,
invitation, setup, and reset URLs.

Security reports must follow [`SECURITY.md`](SECURITY.md), not a public issue.
Optional helpers under `examples/` have the support boundary stated in their own
README and are not part of the Harbor image.

The maintainer may close requests involving unsupported releases, modified images,
unreproducible third-party adapter behavior, or unsafe proxy/network configurations.
Community fixes and sanitized compatibility reports are welcome.
