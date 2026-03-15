# Nostr Relay

A NIP-01 Nostr relay built on Bun with SQLite. Supports NIP-01, NIP-09, NIP-11, NIP-23, NIP-42, NIP-59, and NIP-CF (Changes Feed).

## Local Development

```bash
bun install
bun run dev    # starts on ws://localhost:3000
bun test       # run tests
```

## Deploy to Fly.io

### 1. Install flyctl

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### 2. Create the app

```bash
cd references/relay
fly launch --no-deploy
```

When prompted:
- Pick a name (e.g. `comet-relay`)
- Choose a region close to you
- Say **no** to Postgres/Redis

### 3. Create a persistent volume

SQLite needs persistent storage. Create a 1GB volume in the same region you chose:

```bash
fly volumes create relay_data --size 1 --region ord
```

### 4. Create `fly.toml`

```toml
app = "comet-relay"
primary_region = "ord"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  DB_PATH = "/data/relay.db"
  RELAY_URL = "wss://comet-relay.fly.dev"
  PRIVATE_MODE = "true"

[mounts]
  source = "relay_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    method = "GET"
    path = "/"
```

### 5. Create `Dockerfile`

```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src/ src/

EXPOSE 8080
CMD ["bun", "run", "src/main.ts"]
```

### 6. Set secrets

```bash
# Required for private mode — used to authenticate admin API calls
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32)
```

Save the generated token somewhere safe — you'll need it to manage the allowlist.

### 7. Deploy

```bash
fly deploy
```

Verify it's running:

```bash
# NIP-11 info
curl -H "Accept: application/nostr+json" https://comet-relay.fly.dev

# Health check
curl https://comet-relay.fly.dev
```

## Managing Access

The relay runs in private mode — only allowed pubkeys can connect. Use the admin API to manage access.

### Allow a pubkey

```bash
RELAY=https://comet-relay.fly.dev
TOKEN=your-admin-token

# No expiry (permanent)
curl -X POST $RELAY/admin/allow \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "abc123...64-char-hex..."}'

# With expiry (unix timestamp)
curl -X POST $RELAY/admin/allow \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "abc123...", "expires_at": 1735689600}'
```

### List allowed pubkeys

```bash
curl $RELAY/admin/allow -H "Authorization: Bearer $TOKEN"
```

### Revoke a pubkey

```bash
curl -X DELETE $RELAY/admin/allow/abc123...64-char-hex... \
  -H "Authorization: Bearer $TOKEN"
```

## Open Mode

To run without access restrictions, remove `PRIVATE_MODE` from `fly.toml` or set it to `false`. The admin API will be disabled (no `ADMIN_TOKEN` needed). Gift wrap queries still require NIP-42 AUTH.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WebSocket port |
| `DB_PATH` | `./relay.db` | SQLite database path |
| `RELAY_URL` | `ws://localhost:$PORT` | Public relay URL (used for NIP-42 AUTH validation) |
| `PRIVATE_MODE` | `false` | Require AUTH + allowlist for all operations |
| `ADMIN_TOKEN` | — | Bearer token for admin API (required when `PRIVATE_MODE=true`) |
