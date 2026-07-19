# Compatibility matrix

This matrix separates automated coverage from expected compatibility. “Expected”
means the protocol adapter is implemented, but the beta project does not yet claim
a tested minimum/maximum upstream version. Sanitized community compatibility
reports and fixtures are welcome.

## Harbor runtime

| Component | Supported / tested |
|---|---|
| Container architectures | `linux/amd64` and `linux/arm64`; both are built and run under the CI platform matrix before release |
| Base runtime | Node 24.18.0 LTS on Alpine 3.23, pinned by multi-architecture digest |
| Docker | OCI-compatible Docker Engine; container validation used Engine 29.6.2 |
| Compose | Compose Specification with secrets, health checks, read-only root, tmpfs, and `pull_policy`; local drill used Compose 5.3.1 |
| Database | SQLite schema 3; forward-only migrations from the pre-ledger development schema are tested |
| Browser automation | Playwright Chromium 149; Firefox/Safari are expected but are not certified in the beta matrix |
| Authentication | Local password mode and trusted forward-auth headers are regression-tested; the maintainer's real proxy/Google OAuth deployment is beta field validation rather than a publication gate |

Harbor's release workflow publishes only amd64 and arm64. Other architectures in
the upstream Node manifest are not Harbor-supported artifacts.

## Integration adapters

All 18 adapters pass a catalog/capability contract test. No public minimum upstream
version is claimed yet; integrations not exercised by the maintainer should be
treated as beta compatibility surfaces.

| Adapter | Implemented API surface | Beta evidence |
|---|---|---|
| Sonarr, Radarr | queue, calendar, status, storage | Contract-tested; live version pending |
| Lidarr, Readarr | queue, calendar, status, storage | Contract-tested; live version pending |
| Prowlarr | status, indexers | Contract-tested; live version pending |
| SABnzbd, NZBGet | queue and actions, status | Contract-tested; live version pending |
| qBittorrent, Transmission | queue and actions, status | Contract-tested; live version pending |
| Plex, Tautulli | status, now-playing, recently-added/art | Contract-tested; live version pending |
| Beszel | status, system, storage | Contract-tested; live version pending |
| Portainer | status, read-only containers | Contract-tested; live version pending |
| Audiobookshelf, Kavita | status, progress | Contract-tested; live version pending |
| Jellyseerr | request attribution | Contract-tested; live version pending |
| SQM collector, NINA Advanced API | sky/scope and status | Contract-tested; live version pending |

An adapter returning data outside its tested contract is a compatibility issue, not
permission to weaken Harbor's input, body-size, TLS, or outbound-address controls.
