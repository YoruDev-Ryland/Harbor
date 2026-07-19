# Privacy and data retention

Harbor is self-hosted and does not send telemetry to the Harbor project. It does
contact the integrations, monitors, SMTP server, and private ntfy endpoints that
the operator or individual user configures.

## Data stored

- account names, optional email/phone, password hashes, SSO subjects, group and
  preference data;
- encrypted integration, SMTP, and per-user ntfy credentials;
- service URLs, monitor state and short history, per-user notification feeds,
  and dashboard/calendar preferences;
- one-way digests of setup, invitation, reset, and iCal bearer tokens;
- bounded security audit metadata: actor, route template, status, peer address,
  and timestamp. Request bodies, passwords, API keys, tokens, notification
  contents, and integration responses are not written to the audit log.

Harbor removed the unused connected-Plex-account feature before release. It does
not collect or retain per-user Plex tokens.

## Retention

- notification feeds retain at most 200 records per eligible user;
- website monitor history retains three days;
- security audit history defaults to 180 days and 20,000 rows, whichever is
  reached first (`HARBOR_AUDIT_RETENTION_DAYS`, `HARBOR_AUDIT_MAX_ROWS`);
- used/expired invitation and password-reset records are periodically removed;
- active invitations expire after 1–30 days and password resets after 15
  minutes;
- the operator controls retention of external SMTP, ntfy, reverse-proxy, Docker,
  and backup logs independently.

## Access and deletion

Users can change their own contact, notification, private-push, password, theme,
layout, and calendar-subscription data. Harbormasters can disable an account
without deleting it; disabling revokes sessions and blocks login while retaining
data for a reversible administrative action.

Account deletion is irreversible. Database foreign keys cascade through SSO
identities, reset tokens, notification rows, and private-push credentials. iCal
data and preferences disappear with the user row. Matching invitation residue is
removed, and retained security events anonymize the deleted actor and erase its
peer address. Monitor deletion cascades its history.

Sensitive JSON backups and stopped-volume copies retain whatever existed when
they were created. Deleting a live account does not erase independent backups;
operators must apply their own backup expiry policy.
