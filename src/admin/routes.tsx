import { Hono } from "hono"
import { setCookie, deleteCookie } from "hono/cookie"
import { desc, eq } from "drizzle-orm"
import type { DB } from "../db"
import type { AccessControl } from "../access"
import type { Storage } from "../relay/storage"
import type { ConnectionManager } from "../connections"
import { blobs, events } from "../schema"
import { adminAuth } from "./middleware"
import * as blobDb from "../blossom/db"
import * as s3 from "../blossom/s3"

const SESSION_COOKIE = "admin_session"

type AdminDeps = {
  db: DB
  access: AccessControl
  storage: Storage
  connections: ConnectionManager
  adminToken: string
}

export function adminRoutes(deps: AdminDeps): Hono {
  const { db, access, storage, connections, adminToken } = deps
  const app = new Hono()

  // JSON API: unauthenticated endpoints
  app.post("/api/login", async (c) => {
    const body = await c.req.json<{ token?: string }>()
    if (body.token !== adminToken) {
      return c.json({ error: "invalid token" }, 401)
    }
    setCookie(c, SESSION_COOKIE, adminToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/admin",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })
    return c.json({ ok: true })
  })

  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/admin" })
    return c.json({ ok: true })
  })

  // Protected API routes
  app.use("/api/*", adminAuth(adminToken))

  // Stats
  app.get("/api/stats", async (c) => {
    const [eventCount, blobCount, blobTotalSize] = await Promise.all([
      storage.getEventCount(),
      blobDb.getBlobCount(db),
      blobDb.getBlobTotalSize(db),
    ])
    return c.json({
      connections: connections.size,
      events: eventCount,
      blobs: blobCount,
      blobStorage: blobTotalSize,
    })
  })

  // Allowlist API
  app.get("/api/allow", async (c) => {
    const pubkeys = await access.list()
    return c.json({ pubkeys })
  })

  app.post("/api/allow", async (c) => {
    const body = await c.req.json<{ pubkey?: string; expires_at?: number | null }>()
    if (!body.pubkey || !/^[a-f0-9]{64}$/.test(body.pubkey)) {
      return c.json({ error: "invalid pubkey: must be 64-char hex" }, 400)
    }
    const expiresAt = body.expires_at ?? null
    await access.allow(body.pubkey, expiresAt)
    return c.json({ allowed: true, pubkey: body.pubkey, expires_at: expiresAt })
  })

  app.delete("/api/allow/:pubkey", async (c) => {
    const pubkey = c.req.param("pubkey")
    if (!pubkey || !/^[a-f0-9]{64}$/.test(pubkey)) {
      return c.json({ error: "invalid pubkey" }, 400)
    }
    const revoked = await access.revoke(pubkey)
    return c.json({ revoked }, revoked ? 200 : 404)
  })

  // Blobs API
  app.get("/api/blobs", async (c) => {
    const rows = await db
      .select({ sha256: blobs.sha256, size: blobs.size, type: blobs.type, uploadedAt: blobs.uploadedAt })
      .from(blobs)
      .orderBy(desc(blobs.uploadedAt))
      .limit(100)
    return c.json({
      blobs: rows.map((r) => ({
        sha256: r.sha256,
        size: r.size,
        type: r.type,
        uploaded_at: r.uploadedAt.toISOString(),
      })),
    })
  })

  app.delete("/api/blobs/:sha256", async (c) => {
    const sha256 = c.req.param("sha256")
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
      return c.json({ error: "invalid sha256" }, 400)
    }
    await s3.deleteBlob(sha256)
    await blobDb.deleteBlob(db, sha256)
    return c.json({ deleted: true })
  })

  // Events API
  app.get("/api/events", async (c) => {
    const kindParam = c.req.query("kind")
    const pubkeyParam = c.req.query("pubkey")

    let query = db
      .select({
        id: events.id,
        pubkey: events.pubkey,
        kind: events.kind,
        createdAt: events.createdAt,
        content: events.content,
      })
      .from(events)
      .$dynamic()

    if (kindParam !== undefined) {
      query = query.where(eq(events.kind, Number(kindParam)))
    }
    if (pubkeyParam !== undefined) {
      query = query.where(eq(events.pubkey, pubkeyParam))
    }

    const rows = await query.orderBy(desc(events.createdAt)).limit(100)

    return c.json({
      events: rows.map((r) => ({
        id: r.id,
        pubkey: r.pubkey,
        kind: r.kind,
        created_at: r.createdAt,
        content: r.content.length > 200 ? r.content.slice(0, 200) + "…" : r.content,
      })),
    })
  })

  // Connections API
  app.get("/api/connections", (c) => {
    const conns: { id: string; authedPubkeys: string[] }[] = []
    for (const [id, state] of connections.entries()) {
      conns.push({
        id,
        authedPubkeys: Array.from(state.authedPubkeys),
      })
    }
    return c.json({ connections: conns })
  })

  return app
}
