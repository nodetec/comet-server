# Fly.io commands for comet-server

app := "comet-server"

# Deploy to Fly
deploy:
    fly deploy

# Deploy without build cache
deploy-fresh:
    fly deploy --no-cache

# Open the deployed app in browser
open:
    fly apps open --app {{app}}

# Show app status
status:
    fly status --app {{app}}

# Tail production logs
logs:
    fly logs --app {{app}}

# Open a console on a running machine
ssh:
    fly ssh console --app {{app}}

# List secrets
secrets:
    fly secrets list --app {{app}}

# Set a secret (usage: just set-secret KEY=VALUE)
set-secret *ARGS:
    fly secrets set --app {{app}} {{ARGS}}

# Scale VM memory (usage: just scale-memory 2gb)
scale-memory size:
    fly scale memory {{size}} --app {{app}}

# Show current VM scale
scale:
    fly scale show --app {{app}}

# Run database migrations
migrate:
    fly ssh console --app {{app}} -C "cd /app && bun run drizzle-kit migrate"

# Proxy to the remote database (localhost:15432)
db-proxy:
    fly proxy 15432:5432 --app {{app}}

# Build landing page CSS
build-css:
    bun run build:css

# Build admin UI
build-admin:
    cd admin-ui && bun run build

# Build dashboard UI
build-dashboard:
    cd dashboard-ui && bun run build

# Build everything
build: build-css build-admin build-dashboard
