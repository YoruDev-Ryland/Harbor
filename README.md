# ⚓ Harbor

**The harbor for all of your servers and web apps.** A self-hosted dashboard that
replaces Organizr: embedded application tabs, homepage widgets fed by your services,
SSO through your Traefik forward-auth chain, and a theme engine that can change the
whole character of the app.

> **Beta status:** Harbor `0.x` releases are hobby-project early-access builds.
> The security and artifact gates are real, but compatibility is intentionally
> conservative and there is no support SLA. Back up `/data` and its matching
> master secret before every upgrade, use versioned tags or immutable digests,
> and expect features and configuration to continue evolving before `1.0`.

## Features

- **Berths** — your services live in the sidebar and open *inside* Harbor in
  persistent iframes. Switch between them instantly; frames stay warm like Organizr
  tabs. Apps that refuse framing can open in a new browser tab instead.
- **Release calendar** — Sonarr + Radarr schedules merged into one agenda with
  per-release state: downloaded, downloading, missing, unaired.
- **Unified downloads** — one queue across Sonarr, Radarr, SABnzbd and qBittorrent.
  Every item is tagged with its source client; filter sources with one click. You
  choose per-integration whether to track via the *arr apps, the download clients,
  or both.
- **Fleet status** — up/down + latency for every integration and every berth.
- **SSO / auth proxy** — trusts `Remote-User` / `X-Forwarded-Email` headers from a
  explicitly configured proxy CIDR, auto-provisions users, and honors a required
  `ADMIN_USERS` list. Google
  OAuth in front of Traefik logs you straight in, exactly like Organizr. Local
  accounts remain as a fallback, with a first-run setup screen.
- **Modular** — a new integration is one adapter file (server) registered in a
  catalog; a new widget is one component registered in the frontend.
- **Themes** — CSS-token theme engine with eight bundled themes, including
  **Dockyard** and **Slate**. Per-user choice plus an instance default.
- **Encrypted credentials** — integration API keys are AES-256-GCM encrypted at
  rest and are not returned by ordinary configuration APIs.

## Deploying into a Traefik stack

[deploy/harbor.yml](deploy/harbor.yml) is a ready-made pull-only `services/*.yml`
include for a `$DOCKERDIR`-style stack (Traefik + forward-auth chain, file-based
secrets, includes in the root Compose file). Follow the numbered steps at the top
of that file: preserve the existing `/data` directory and `harbor_secret`, set
`HARBOR_IMAGE` plus the required hostname/proxy/admin values, add the include, then
run `docker compose pull harbor && docker compose up -d harbor`. A source checkout
is not required on the Docker host.

Your OAuth middleware (e.g. `chain-oauth@file`) sets `X-Forwarded-User` after Google
login; Harbor accepts it only when the request arrives directly from Traefik's
subnet (`AUTH_PROXY_TRUSTED`) and signs you in automatically.

## Quick start (standalone)

```bash
docker compose up -d --build   # http://localhost:9090
```

The standalone port binds to `127.0.0.1` and trusted-header authentication is off.
On first start, Harbor creates a one-time bootstrap token in the data volume. Read
it, then enter it on the setup screen:

```bash
docker compose exec harbor cat /data/.setup-token
```

The token is removed after the first administrator is created. The session/encryption
secret also auto-generates into the data volume if `HARBOR_SECRET` is unset.

For published standalone images, use the hardened pull-only
[`deploy/compose.release.yml`](deploy/compose.release.yml) and pin
`HARBOR_IMAGE` to the release digest. Signature/SBOM verification and the release
verification command are documented in
[`guides/VERIFY_RELEASE.md`](guides/VERIFY_RELEASE.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HARBOR_SECRET` | *(auto-generated)* | Signs sessions, encrypts integration secrets |
| `HARBOR_SECRET_FILE` | — | Docker-secrets alternative: path to a file containing the secret (takes precedence) |
| `HARBOR_PREVIOUS_SECRET_FILE` | *(none)* | Temporary in-container path to a read-only old-secret mount used for transactional credential re-encryption |
| `HARBOR_SETUP_TOKEN` | *(auto-generated)* | Explicit one-time first-run token (32+ characters) |
| `HARBOR_SETUP_TOKEN_FILE` | `/data/.setup-token` | Docker-secret or generated-token path |
| `PORT` | `9090` | Listen port |
| `HARBOR_DATA` | `/data` | SQLite + generated secret location |
| `SESSION_DAYS` | `7` | Session-cookie lifetime, from 1 through 90 days |
| `PUBLIC_URL` | *(none)* | Canonical external origin; required with proxy auth and used for generated links |
| `AUTH_PROXY` | `false` | Trust forward-auth identity headers |
| `AUTH_PROXY_PROVIDER` | `proxy` | Stable namespace for forward-auth subjects; do not change after provisioning |
| `AUTH_PROXY_HEADERS` | `Remote-User,X-Forwarded-User,X-Forwarded-Email,X-Auth-Request-Email` | Headers checked, first match wins |
| `AUTH_PROXY_TRUSTED` | *(none)* | Required explicit CIDRs allowed to assert identity |
| `HARBOR_OUTBOUND_STRICT_PRIVATE` | `false` | Hardened opt-in requiring private destinations to match an outbound allow-list |
| `HARBOR_OUTBOUND_ALLOW_CIDRS` | *(none)* | Private/CGNAT/ULA networks permitted when strict private mode is enabled |
| `HARBOR_OUTBOUND_ALLOW_HOSTS` | *(none)* | Exact private service names (or `*.example.internal`) permitted in strict mode |
| `HARBOR_OUTBOUND_MAX_CONCURRENCY` | `12` | Global outbound request ceiling (1–64) |
| `HARBOR_OUTBOUND_PER_ORIGIN` | `4` | Per-service connection ceiling (1–16, no higher than global) |
| `HARBOR_AUDIT_RETENTION_DAYS` | `180` | Security audit history age limit (7–3650 days) |
| `HARBOR_AUDIT_MAX_ROWS` | `20000` | Hard cap for retained security audit events |
| `HARBOR_SMTP_CA_FILE` | *(none)* | Mounted PEM CA bundle for a private SMTP relay |
| `ADMIN_USERS` | *(none)* | Required explicit administrator identities when proxy auth is enabled |

When enabling proxy authentication, Harbor refuses to start unless `PUBLIC_URL`,
`AUTH_PROXY_TRUSTED`, and `ADMIN_USERS` are explicit and non-empty. Trust entries
must be valid IPv4 CIDRs no broader than `/16`. Do not expose a second route that
bypasses the authenticating proxy. SSO accounts bind to the exact stable subject
from `AUTH_PROXY_HEADERS`; mutable email matching is not used. Passwordless
accounts created by older Harbor SSO builds may migrate on an exact username
match. A password-bearing local account must be explicitly bound by an
administrator under Harbormaster → Crew before that SSO subject can use it.

Harbor allows public targets and normal private Docker/LAN, CGNAT, and IPv6 ULA
destinations by default so internal URLs such as `http://sonarr:8989` work
without extra configuration. Loopback, link-local/cloud-metadata, multicast,
unspecified, and reserved destinations remain blocked and cannot be allow-listed.
Every redirect and the DNS result used for the actual socket are revalidated.

For a hardened deployment, set `HARBOR_OUTBOUND_STRICT_PRIVATE=true`; private
destinations must then match `HARBOR_OUTBOUND_ALLOW_CIDRS` or
`HARBOR_OUTBOUND_ALLOW_HOSTS`. Exact Docker names such as
`sonarr,radarr,ntfy,relay` are safer than granting an entire LAN. Harbor should
only be attached to Docker networks containing services it needs to reach.

Stored credentials are write-only. Changing an integration origin, SMTP
host/port/TLS identity/username, or ntfy origin clears the retained credential
unless a replacement is supplied in the same request. The separate “Manage
service credentials” permission controls who may enter replacements.

Back up before every upgrade. Harbor provides a versioned, same-master-key
sensitive JSON backup and a documented stopped-volume disaster-recovery path;
see [Backup, restore, and upgrade](guides/BACKUP_RESTORE.md). Calendar, reset, and
invite bearers are stored only as digests and token-like query parameters are
redacted from Harbor logs. Configure equivalent redaction in the reverse proxy.
The stored-data and deletion model is documented in [Privacy and data
retention](guides/PRIVACY.md).

## Optional notification helpers

Hardened opt-in templates for a private ntfy server and Harbor's MIT-licensed SMS
relay helper live under [examples/notifications](examples/notifications/). ntfy is
supported by Harbor's notification settings. The SMS relay is a standalone helper
for trusted automation clients; native Harbor SMS delivery is not implemented yet.

## Development

```bash
npm ci
npm run dev        # API on :9090, Vite on :5173 (proxied /api)
npm run ci         # format, lint, types, API/contract tests, build, licenses
npm run test:e2e   # Chromium flows + axe WCAG checks (after Playwright install)
npm run test:container
npm run test:helper # Optional SMS relay container security smoke
```

Release support, compatibility, upgrade, security, and change information lives in
[`SUPPORT.md`](SUPPORT.md), [`guides/COMPATIBILITY.md`](guides/COMPATIBILITY.md),
[`guides/UPGRADING.md`](guides/UPGRADING.md), [`SECURITY.md`](SECURITY.md), and
[`CHANGELOG.md`](CHANGELOG.md). Contributions are covered by
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Adding a module

1. **Server adapter:** create `server/src/modules/adapters/<type>.ts` implementing
   `IntegrationAdapter` (declare `capabilities` and `fields`), register it in
   `server/src/modules/registry.ts`. The settings UI renders its form automatically.
2. **Widget:** create `web/src/widgets/<Name>Widget.tsx`, register it in
   `web/src/widgets/registry.ts`.

## Embedding notes

Embedded berths require the target app to allow framing. Most self-hosted apps
behind your own domain work out of the box; some — notably **Portainer**
(hardcoded `X-Frame-Options: DENY`) and **Kavita** (restrictive
`frame-ancestors` CSP) — refuse to be framed and the browser shows *"…will not
allow Firefox to display the page…"*. No Harbor-side setting can override
another origin's response headers; the fix belongs on *that app's* Traefik
router. Harbor frames berths in a sandbox that permits scripts, forms,
same-origin storage, popups, and downloads, but does not grant clipboard,
camera, microphone, location, or top-navigation access. Add these labels to the
blocked app's service (e.g. Portainer, Kavita):

```yaml
# 1. define the middleware (only needs to exist once in the whole stack)
- "traefik.http.middlewares.allow-frames.headers.customresponseheaders.X-Frame-Options="
- "traefik.http.middlewares.allow-frames.headers.contentSecurityPolicy=frame-ancestors 'self' https://harbor.example.com"
# 2. attach it to THIS app's router — the step people miss. Append to the
#    existing chain; don't drop the app's auth middleware:
- "traefik.http.routers.portainer-rtr.middlewares=chain-oauth@file,allow-frames"
```

The empty `X-Frame-Options=` removes the app's header; the CSP line replaces its
`frame-ancestors` so `harbor.example.com` is allowed. Recreate the app container
(`docker compose up -d portainer`) for Traefik to pick up the new labels.

**Instant fallback (no infra change):** in Harbor, set the berth's open mode to
*Open in new tab* (Harbormaster → Berths). It stops trying to frame the app and
opens it in a fresh tab instead — useful for apps you can't or don't want to
reconfigure.

## License

Harbor is free software released under the [MIT License](LICENSE). Bundled font
and dependency attributions are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). An optional donation link does
not change the license or anyone's right to use, modify, or redistribute Harbor.
