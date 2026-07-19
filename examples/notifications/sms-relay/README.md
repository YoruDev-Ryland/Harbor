# Harbor SMS relay helper

This Harbor-owned, MIT-licensed helper translates a small authenticated JSON API
into SignalWire's compatibility API. It is optional and is not included in the
Harbor image.

Harbor does **not** currently call this relay itself. Use it with trusted internal
automation/webhook clients today, or retain it as a deployment template until
native Harbor SMS delivery is implemented.

## Security model

The relay fails startup unless it has:

- a SignalWire space, project ID, API token, and E.164 sending number;
- a relay API key containing at least 32 characters; and
- an explicit E.164 recipient allowlist, unless unrestricted destinations are
  deliberately enabled.

It has no published host port, attaches only to the configured Harbor Docker
network, accepts JSON bodies up to 16 KiB, limits message length and send rates,
caps concurrent requests, times out SignalWire, and redacts phone numbers and
provider errors in logs. These controls reduce risk; they do not replace provider
spending limits, recipient consent, credential rotation, or applicable messaging
rules.

## Configure and start

Harbor must already be running so its Docker network exists.

```bash
cd examples/notifications/sms-relay
cp .env.example .env
mkdir -p secrets
openssl rand -hex 32 > secrets/relay_api_key
printf '%s' 'your-project-id' > secrets/signalwire_project_id
printf '%s' 'your-messaging-api-token' > secrets/signalwire_api_token
chmod 600 secrets/*
docker compose up -d --build
```

Edit `.env` first. Set the SignalWire space hostname and sending number, list every
permitted destination in `SMS_ALLOWED_RECIPIENTS`, and change `HARBOR_NETWORK` if
your Docker network is not `harbor_default`. `.env` and `secrets/` are ignored by
Git.

Use a SignalWire token limited to the permissions needed for messaging. Configure
provider-side spending/usage alerts and rotate both provider and relay credentials
if either may have been disclosed.

## API

Send `POST http://sms-relay:8080/send` from a container on the same Docker network:

```bash
curl --fail-with-body http://sms-relay:8080/send \
  -H "Authorization: Bearer $SMS_RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"to":"+15550100002","message":"Backup completed."}'
```

`X-Api-Key` is accepted for clients that cannot set a Bearer header. Never place the
key in a URL. A successful provider acceptance returns HTTP 202 with a request ID
and, when supplied by SignalWire, its message SID. Actual carrier delivery remains
asynchronous.

`GET /health` is unauthenticated and returns only `{ "ok": true }`. It does not
contact SignalWire or expose configuration.

## Guardrails

| Variable | Default | Purpose |
|---|---:|---|
| `SMS_ALLOWED_RECIPIENTS` | required | Comma-separated E.164 destination allowlist |
| `SMS_ALLOW_ANY_RECIPIENT` | `false` | Explicitly disables the destination allowlist; not recommended |
| `RELAY_RATE_LIMIT_PER_MINUTE` | `6` | Global in-memory per-minute send cap |
| `RELAY_DAILY_LIMIT` | `100` | Global in-memory UTC-day send cap |
| `MAX_MESSAGE_CHARS` | `480` | Maximum message length, capped internally at 1600 |
| `MAX_CONCURRENT_SENDS` | `2` | Maximum simultaneous provider requests |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Provider timeout, capped internally at 30 seconds |
| `REQUEST_BODY_LIMIT_BYTES` | `16384` | JSON request cap, capped internally at 64 KiB |

The in-memory counters reset when the container restarts. Provider-side limits are
therefore essential for meaningful cost protection.

## Operations

```bash
docker compose ps
docker compose logs sms-relay
docker compose exec sms-relay wget -qO- http://127.0.0.1:8080/health
```

The service intentionally logs only masked destinations, request IDs, provider
status/code, and accepted message SIDs. It never logs message bodies, credentials,
full phone numbers, or raw provider responses.
