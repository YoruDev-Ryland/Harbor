# Upgrade and rollback

## Before every upgrade

1. Read `CHANGELOG.md` and the target release notes.
2. Stop Harbor and preserve the complete `/data` volume plus its matching master
   secret as described in [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md).
3. Also create a sensitive JSON backup and store it in an encrypted location.
4. Record the currently running image digest. Do not use `latest` as a rollback
   reference.

## Pull-based upgrade

Set `HARBOR_IMAGE` in [`deploy/compose.release.yml`](../deploy/compose.release.yml)
to the new immutable `ghcr.io/OWNER/harbor@sha256:...` digest, then run:

```bash
docker compose -f deploy/compose.release.yml pull
docker compose -f deploy/compose.release.yml up -d
docker compose -f deploy/compose.release.yml exec harbor node server/dist/cli.js status
```

Confirm readiness, schema, local or forward-auth login, groups, an integration, a
monitor, notification preferences, and calendar status. Keep the pre-upgrade backup
until the deployment has been stable.

For the Traefik include in [`deploy/harbor.yml`](../deploy/harbor.yml), update
`HARBOR_IMAGE` in the parent stack and run its equivalent commands:

```bash
docker compose pull harbor
docker compose up -d harbor
docker compose exec harbor node server/dist/cli.js status
```

When moving from a pre-public source-built Harbor container, replace the old
`build:` service with the current pull-only template but keep the same host
directory mounted at `/data` and the same `harbor_secret` file. Existing accounts,
groups, integrations, and settings migrate in place; a fresh setup is not expected.
Do not accidentally create an empty replacement data directory or a new secret.

Migrations are forward-only and transactional. Never start an older image against a
database after a newer image has migrated it. To roll back, stop the failed upgrade,
restore the entire pre-upgrade data/secret recovery set into a new empty volume, and
start the previously recorded image digest. Restoring only `harbor.db` from a live
WAL-mode instance is not supported.

The key-derivation change introduced before the first public release invalidates
older browser cookies once. A forward-auth user should immediately sign back in; a
local user uses the existing password. The removed shared ntfy and unused
linked-Plex-account credentials are deliberately not migrated into replacement
features.
