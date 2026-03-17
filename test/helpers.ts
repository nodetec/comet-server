import { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import { sql as rawSql } from "drizzle-orm"
import { createDB, type DB } from "../src/db"
import { ConnectionManager } from "../src/connections"
import { initStorage, type Storage } from "../src/relay/storage"
import { initAccessControl, type AccessControl } from "../src/access"
import { handleMessage, handleDisconnect, type RelayDeps } from "../src/relay/handler"
import { getRelayInfoDocument } from "../src/relay/nip/11"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import type postgres from "postgres"

const TEST_DB_URL = process.env.TEST_DATABASE_URL || "postgres://localhost/comet_test"

export type TestContext = {
  db: DB
  sql: postgres.Sql
  storage: Storage
  access: AccessControl
  connections: ConnectionManager
  server: ReturnType<typeof Bun.serve>
  port: number
  relayUrl: string
  cleanup: () => Promise<void>
}

/** Truncate all tables for a clean test run. */
async function truncateAll(db: DB) {
  await db.execute(rawSql`TRUNCATE events, event_tags, deleted_events, deleted_coords, changes, change_tags, allowed_pubkeys, blobs, blob_owners CASCADE`)
  // Reset identity sequence for changes.seq so tests get predictable low numbers
  await db.execute(rawSql`ALTER SEQUENCE changes_seq_seq RESTART WITH 1`)
}

/**
 * Start a test relay server on the given port.
 * Each test suite should use a unique port.
 */
export async function startTestRelay(port: number, opts?: { privateMode?: boolean }): Promise<TestContext> {
  const { db, sql } = createDB(TEST_DB_URL)
  await migrate(db, { migrationsFolder: "./drizzle" })
  await truncateAll(db)

  const storage = initStorage(db)
  const access = await initAccessControl(db, opts?.privateMode ?? false)
  const connections = new ConnectionManager()

  const { upgradeWebSocket, websocket } = createBunWebSocket()
  const app = new Hono()
  const relayUrl = `ws://localhost:${port}`

  const relayDeps: RelayDeps = { storage, connections, relayUrl, access }

  // WebSocket upgrade must be registered first
  app.get(
    "/",
    upgradeWebSocket(() => {
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
  )

  app.get("/", async (c) => {
    const accept = c.req.header("Accept") ?? ""
    if (accept.includes("application/nostr+json")) {
      const minSeq = await storage.getMinSeq()
      return c.json(getRelayInfoDocument(minSeq), 200, {
        "Content-Type": "application/nostr+json",
      })
    }
    return c.text("ok")
  })

  const server = Bun.serve({ port, fetch: app.fetch, websocket })

  return {
    db, sql, storage, access, connections, server, port, relayUrl,
    cleanup: async () => {
      server.stop()
      await sql.end()
    },
  }
}

// --- WebSocket helpers ---

export async function connectWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(e)
  })
  await new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string)
      if (msg[0] === "AUTH") resolve()
    }
  })
  return ws
}

export async function connectRaw(port: number): Promise<{ ws: WebSocket; challenge: string }> {
  const ws = new WebSocket(`ws://localhost:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(e)
  })
  const challenge = await new Promise<string>((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string)
      if (msg[0] === "AUTH") resolve(msg[1])
    }
  })
  return { ws, challenge }
}

export function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
    ws.onmessage = (e) => {
      clearTimeout(timer)
      resolve(JSON.parse(e.data as string))
    }
  })
}

export function waitForMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[][]> {
  return new Promise((resolve) => {
    const messages: unknown[][] = []
    const timer = setTimeout(() => resolve(messages), timeoutMs)
    ws.onmessage = (e) => {
      messages.push(JSON.parse(e.data as string))
      if (messages.length >= count) {
        clearTimeout(timer)
        resolve(messages)
      }
    }
  })
}
