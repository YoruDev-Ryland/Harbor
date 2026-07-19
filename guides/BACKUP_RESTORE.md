# Backup, restore, and upgrade runbook

Harbor has two complementary backup paths. Use both before every upgrade.

## 1. Sensitive JSON backup

Harbormaster → Backup exports a versioned snapshot of every durable application
table: users and password hashes, identities, preferences, permission groups,
berths, integrations and encrypted credentials, settings/SMTP, private push
endpoints, monitors/history, notification feeds, calendar-token digests, and the
security audit log. One-time password resets and invitations are intentionally
excluded because their plaintext bearer values are never stored and should not
survive a restore.

The file is not independently encrypted. Store it in an encrypted backup target.
Restore requires the same `HARBOR_SECRET`; Harbor checks a non-secret key
fingerprint before changing data. A restore runs in one transaction, performs a
foreign-key check, preserves the last-enabled-administrator invariant, and rolls
back completely on failure. Restored sessions are revoked.

## 2. Full data/secret backup

This is the authoritative disaster-recovery copy. Stop Harbor first so the
database, WAL, and shared-memory files are consistent:

```bash
docker compose stop harbor
```

Copy the entire directory or named volume mounted at `/data`, including hidden
files. It normally contains `.secret`, `harbor.db`, and possibly
`harbor.db-wal`/`harbor.db-shm`. If `HARBOR_SECRET_FILE` points outside `/data`,
back up that secret file separately with the same recovery set.

For a bind mount, archive the explicit host directory configured for Harbor:

```bash
tar -C /srv/harbor -czf harbor-data-YYYY-MM-DD.tar.gz data
```

Replace `/srv/harbor` only with the exact parent of your Harbor data directory.
After the copy completes, restart Harbor:

```bash
docker compose start harbor
```

Do not use `docker compose down -v`; it deletes a named data volume. Do not copy
only `harbor.db` from a running WAL-mode database.

## Restore drill

1. Keep the original container stopped and preserve its data untouched.
2. Restore the complete data directory/volume and external secret, if used, to a
   disposable Harbor deployment owned by container UID 1000.
3. Start the same or a newer supported Harbor image. Never start an older build
   against a database that has already migrated forward.
4. Confirm `/api/health/ready` reports the expected schema version.
5. Verify local login or proxy SSO, groups, one integration, one monitor, private
   push configuration, notification history, and calendar subscription status.
6. Export a new sensitive JSON backup and retain the old recovery set until the
   upgraded deployment has been stable.

## Key loss and account recovery

Losing `.secret` or the configured `HARBOR_SECRET_FILE` invalidates sessions and
makes encrypted integration, SMTP, and private-push credentials unrecoverable.
Password hashes remain usable, but encrypted credentials must be re-entered.
Never replace the secret as an attempted password reset.

For a planned rotation, set the active `HARBOR_SECRET`/`HARBOR_SECRET_FILE` to
the new value and temporarily mount the old value at
`HARBOR_PREVIOUS_SECRET_FILE`. On startup Harbor decrypts and re-encrypts every
integration, SMTP, and private-push credential in one transaction; any failure
aborts startup without a partial rotation. Verify integrations and create a new
backup, then remove the previous-secret mount. Existing sessions are revoked by
the signing-key change.

`HARBOR_PREVIOUS_SECRET_FILE` is a path *inside the container*, not a host path.
For a Compose deployment, add a temporary read-only bind or Docker secret such
as `/run/secrets/harbor_previous_secret`, set the variable to that container
path, and remove both after the verified rotation. Ensure the new active secret
remains mounted on every later start; do not fall back to an old `/data/.secret`.

An administrator can issue one-time reset links in Harbormaster → Crew. If no
administrator can sign in, run the audited container CLI against the existing
data volume:

```bash
docker compose exec harbor node server/dist/cli.js status
docker compose exec harbor node server/dist/cli.js reset-password USERNAME
docker compose exec harbor node server/dist/cli.js revoke-sessions USERNAME
```

The reset link is displayed once, expires after 15 minutes, revokes prior
sessions, and is stored only as a digest. Deliver it over a private channel.

## Log redaction

Harbor redacts token-like query parameters in its own request logs. Configure
the reverse proxy to redact the `token` query parameter as well; otherwise iCal,
invite, or reset bearer values may appear in proxy access logs.
