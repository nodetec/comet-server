import type { ServerWebSocket } from "bun"
import { initStorage } from "./storage"
import { initAccessControl, handleAdminRequest } from "./access"
import { handleNip11Request } from "./nip-11"
import { handleMessage, handleOpen, handleDisconnect } from "./relay"
import type { WSData } from "./subscription"

const PORT = parseInt(process.env.PORT ?? "3000", 10)
const DB_PATH = process.env.DB_PATH ?? "./relay.db"
const RELAY_URL = process.env.RELAY_URL ?? `ws://localhost:${PORT}`
const PRIVATE_MODE = process.env.PRIVATE_MODE === "true"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ""

if (PRIVATE_MODE && !ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN must be set when PRIVATE_MODE is enabled")
  process.exit(1)
}

const storage = initStorage(DB_PATH)
const access = initAccessControl(storage.db, PRIVATE_MODE)
const connections = new Map<string, ServerWebSocket<WSData>>()

const server = Bun.serve<WSData>({
  port: PORT,

  fetch(req, server) {
    // WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const id = crypto.randomUUID()
      const challenge = crypto.randomUUID()
      const success = server.upgrade(req, {
        data: { id, challenge, authedPubkeys: new Set<string>() },
      })
      return success ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
    }

    // Admin API
    if (ADMIN_TOKEN) {
      const adminResponse = handleAdminRequest(req, access, ADMIN_TOKEN)
      if (adminResponse) return adminResponse
    }

    // NIP-11 relay info document
    const accept = req.headers.get("accept") ?? ""
    if (accept.includes("application/nostr+json")) {
      return handleNip11Request(storage.getMinSeq())
    }

    return new Response("Use a Nostr client to connect.", { status: 200 })
  },

  websocket: {
    open(ws) {
      handleOpen(ws, connections)
    },

    message(ws, message) {
      handleMessage(ws, message as string, {
        storage,
        connections,
        server,
        relayUrl: RELAY_URL,
        access,
      })
    },

    close(ws) {
      handleDisconnect(ws, connections)
    },

    perMessageDeflate: true,
    maxPayloadLength: 128 * 1024, // 128 KB
  },
})

console.log(`Nostr relay running on ws://localhost:${server.port}${PRIVATE_MODE ? " (private mode)" : ""}`)

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...")
  storage.close()
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", () => {
  storage.close()
  server.stop()
  process.exit(0)
})
