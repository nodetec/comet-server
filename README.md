# Nostr Relay

A NIP-01 Nostr relay built on Bun with SQLite. Supports NIP-01, NIP-09, NIP-11, NIP-23, NIP-42, NIP-59, and NIP-CF (Changes Feed).

## Local Development

```bash
bun install
bun run dev    # starts on ws://localhost:3000
bun test       # run tests
```

## Deploy to Fly.io

The repo includes a `fly.toml` and `Dockerfile`. Deploys automatically on push to `master` via Fly's GitHub integration.

### First-time setup

1. Create a persistent volume for SQLite (must match the region in `fly.toml`):

```bash
fly volumes create relay_data --size 1 --region ams -a sync-relay-q5gzcq
```

2. Set secrets:

```bash
# Generate and save the admin token
export ADMIN_TOKEN=$(openssl rand -hex 32)
echo "Admin token: $ADMIN_TOKEN"

fly secrets set ADMIN_TOKEN=$ADMIN_TOKEN PRIVATE_MODE=true -a sync-relay-q5gzcq
```

3. Push to `master` to trigger the first deploy, or deploy manually:

```bash
fly deploy
```

4. Verify:

```bash
curl -H "Accept: application/nostr+json" https://sync-relay-q5gzcq.fly.dev
```

## Managing Access

When `PRIVATE_MODE` is enabled, only allowed pubkeys can connect. Use the admin API to manage the allowlist.

```bash
RELAY=https://sync-relay-q5gzcq.fly.dev
TOKEN=your-admin-token

# Allow a pubkey (permanent)
curl -X POST $RELAY/admin/allow \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "abc123...64-char-hex..."}'

# Allow with expiry (unix timestamp)
curl -X POST $RELAY/admin/allow \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "abc123...", "expires_at": 1735689600}'

# List allowed pubkeys
curl $RELAY/admin/allow -H "Authorization: Bearer $TOKEN"

# Revoke a pubkey
curl -X DELETE $RELAY/admin/allow/abc123...64-char-hex... \
  -H "Authorization: Bearer $TOKEN"
```

## Open Mode

To run without access restrictions, don't set `PRIVATE_MODE` or set it to `false`. The admin API requires `ADMIN_TOKEN` to be set. Gift wrap queries always require NIP-42 AUTH regardless of mode.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WebSocket port |
| `DB_PATH` | `./data/relay.db` | SQLite database path |
| `RELAY_URL` | `ws://localhost:$PORT` | Public relay URL (used for NIP-42 AUTH validation) |
| `PRIVATE_MODE` | `false` | Require AUTH + allowlist for all operations |
| `ADMIN_TOKEN` | — | Bearer token for admin API (required when `PRIVATE_MODE=true`) |
