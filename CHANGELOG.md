# Changelog

All notable Harbor changes are recorded here. Harbor follows Semantic Versioning
once a public release is tagged.

## [Unreleased]

### Added

- Local accounts and trusted reverse-proxy SSO with stable identity bindings,
  revocable sessions, one-time setup, invitations, password recovery, and account
  lifecycle controls.
- Groups and granular permissions for dashboards, integrations, credentials,
  monitors, notifications, users, and configuration.
- Eighteen service adapters, dashboard widgets, iframe berths, release calendars,
  unified downloads, fleet status, themes, and private notifications.
- Versioned backup/restore, transactional migrations, security event history, and
  master-key rotation support.
- Pull-only standalone and Traefik deployment templates and signed
  multi-architecture container publishing with SBOM and provenance.

### Changed

- Standalone and proxy deployment templates now use a read-only root, dropped
  Linux capabilities, `no-new-privileges`, a bounded `/tmp`, and graceful stops.
- Container builds use an immutable Node 24.18.0 LTS/Alpine 3.23 base-image digest.

### Security

- Added server-enforced module/source authorization, credential retargeting
  protection, bounded outbound networking, private notification delivery,
  security headers, origin checks, input limits, and secret-safe logging.
