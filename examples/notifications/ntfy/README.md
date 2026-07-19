# Private ntfy helper for Harbor

This template runs the official ntfy server as an optional companion to Harbor.
It is configured deny-by-default: anonymous clients cannot publish or subscribe,
and the service is exposed on the host's loopback interface only.

The template currently pins `binwiederhier/ntfy:v2.23.0` and its multi-platform
manifest digest. ntfy is a separate third-party project; review its release notes,
licenses, tag, and digest before upgrading.

## Start the service

Harbor must already be running so its Docker network exists.

```bash
cd examples/notifications/ntfy
cp .env.example .env
mkdir -p data
chown "$(id -u):$(id -g)" data
docker compose up -d
```

Set `NTFY_UID` and `NTFY_GID` in `.env` to the values printed by `id -u` and
`id -g`; they must match the owner of `data/`.

Set `NTFY_BASE_URL` in `.env` to the public HTTPS URL used by the phone app. The
template publishes ntfy only on `127.0.0.1:8085`; configure your existing reverse
proxy to forward that hostname to the loopback port. Do not change it to a public
host bind merely to make routing easier.

If your Harbor Compose project/network has a different name, set
`HARBOR_NETWORK`. Confirm it with `docker network ls` rather than guessing.

## Create least-privilege per-user accounts

Create a separate topic and publisher/subscriber pair for each Harbor user. The
example below provisions the Harbor user `alice`; repeat with a different topic
and identities for every person. Password prompts are interactive and are not
written into Compose files.

```bash
docker compose exec ntfy ntfy user add harbor-alice-publisher
docker compose exec ntfy ntfy access harbor-alice-publisher harbor-alice write-only
docker compose exec ntfy ntfy token add --label="Harbor Alice publisher" harbor-alice-publisher

docker compose exec ntfy ntfy user add harbor-alice-subscriber
docker compose exec ntfy ntfy access harbor-alice-subscriber harbor-alice read-only
docker compose exec ntfy ntfy token add --label="Harbor Alice phone" harbor-alice-subscriber
```

Save each displayed token in a password manager. ntfy tokens inherit all access
held by their user, which is why the publisher and subscriber identities are
separate.

## Connect Harbor

Alice configures Account → Private phone push:

- URL: `http://ntfy:8080`
- Topic: `harbor-alice`
- Publisher token: the `harbor-alice-publisher` token

Private Docker service names work in Harbor without an outbound allow-list. If
you deliberately enabled `HARBOR_OUTBOUND_STRICT_PRIVATE`, add `ntfy` to
`HARBOR_OUTBOUND_ALLOW_HOSTS`.

Enable push, save, and send a test. In the ntfy phone app, add your public HTTPS
server, authenticate as `harbor-alice-subscriber` (or use its token), and
subscribe to `harbor-alice`. Harbor delivers to this endpoint only after the same
per-user module visibility, requester-only, and dedupe checks as the in-app feed.
Never reuse one topic or subscriber credential across Harbor users.

## Operations

Back up `data/`; it contains the ntfy message cache, accounts, ACLs, and tokens.
Protect backups like credentials. Useful commands:

```bash
docker compose ps
docker compose exec ntfy ntfy user list
docker compose exec ntfy ntfy access
docker compose exec ntfy ntfy token list
curl --fail http://127.0.0.1:8085/v1/health
```

Before updating the pinned image, read the upstream migration/release notes, back
up `data/`, pull explicitly, and verify health plus publish/subscribe behavior.
