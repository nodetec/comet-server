import { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import { serveStatic } from "hono/bun"
import { cors } from "hono/cors"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { createDB } from "./db"
import { ConnectionManager } from "./connections"
import { initStorage } from "./relay/storage"
import { initAccessControl } from "./access"
import { handleMessage, handleDisconnect } from "./relay/handler"
import type { RelayDeps } from "./relay/handler"
import { getRelayInfoDocument } from "./relay/nip/11"
import { blossomRoutes } from "./blossom/routes"
import { adminRoutes } from "./admin/routes"
import { initS3 } from "./blossom/s3"
import { getLatestRelease } from "./landing/github"
import { LandingPage } from "./landing/page"

const PORT = parseInt(process.env.PORT ?? "3000", 10)
const RELAY_URL = process.env.RELAY_URL ?? `ws://localhost:${PORT}`
const PRIVATE_MODE = process.env.PRIVATE_MODE === "true"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ""

if (PRIVATE_MODE && !ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN must be set when PRIVATE_MODE is enabled")
  process.exit(1)
}

// Initialize database
const { db, sql } = createDB()
await migrate(db, { migrationsFolder: "./drizzle" })

// Initialize storage and access control
const storage = initStorage(db)
const access = await initAccessControl(db, PRIVATE_MODE)
const connections = new ConnectionManager()

// Initialize S3 (Tigris)
initS3()

// Create Hono app with WebSocket support
const { upgradeWebSocket, websocket } = createBunWebSocket()

const app = new Hono()

// CORS for blossom routes
app.use("/*", cors())

// Relay deps shared across handlers
const relayDeps: RelayDeps = {
  storage,
  connections,
  relayUrl: RELAY_URL,
  access,
}

// WebSocket upgrade on root and /ws
const wsHandler = upgradeWebSocket(() => {
  const connId = crypto.randomUUID()
  const challenge = crypto.randomUUID()
  return {
    onOpen: (_evt, ws) => {
      connections.add(connId, challenge, ws)
      connections.sendJSON(connId, ["AUTH", challenge])
    },
    onMessage: async (evt) => {
      await handleMessage(connId, evt.data as string, relayDeps)
    },
    onClose: () => {
      handleDisconnect(connId, relayDeps)
    },
  }
})
app.get("/ws", wsHandler)
app.get("/", wsHandler)

// Static assets (landing page CSS, images)
app.get("/public/*", serveStatic({ root: "./src/" }))

// NIP-11 and landing page (only reached for non-upgrade requests)
app.get("/", async (c) => {
  const accept = c.req.header("Accept") ?? ""
  if (accept.includes("application/nostr+json")) {
    const minSeq = await storage.getMinSeq()
    return c.json(getRelayInfoDocument(minSeq), 200, {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Accept",
    })
  }
  const release = await getLatestRelease()
  return c.html(<LandingPage release={release} />)
})

// Blossom blob routes
app.route("/", blossomRoutes(db))

// Admin portal
if (ADMIN_TOKEN) {
  app.route("/admin", adminRoutes({
    db,
    access,
    storage,
    connections,
    adminToken: ADMIN_TOKEN,
  }))

  // Serve admin SPA static assets
  app.get("/admin/assets/*", serveStatic({ root: "./admin-ui/dist/", rewriteRequestPath: (path) => path.replace("/admin/", "/") }))

  // SPA fallback: any /admin/* route that wasn't handled above serves index.html
  app.get("/admin/*", serveStatic({ root: "./admin-ui/dist/", path: "index.html" }))
}

// Start server
const server = Bun.serve({
  port: PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`Nostr relay running on ws://localhost:${server.port}${PRIVATE_MODE ? " (private mode)" : ""}`)

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...")
  await sql.end()
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await sql.end()
  server.stop()
  process.exit(0)
})
