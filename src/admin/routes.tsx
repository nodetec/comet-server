import { Hono } from "hono"
import { setCookie, deleteCookie } from "hono/cookie"
import { count, desc, eq, sql } from "drizzle-orm"
import type { DB } from "../db"
import type { AccessControl } from "../access"
import type { Storage } from "../relay/storage"
import type { ConnectionManager } from "../connections"
import { blobs, blobOwners, events, inviteCodes } from "../schema"
import { generateCode } from "../access"
import { adminAuth } from "./middleware"
import * as blobDb from "../blossom/db"
import { DEFAULT_STORAGE_LIMIT_BYTES } from "../blossom/db"
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
    const [pubkeys, usageMap] = await Promise.all([
      access.list(),
      blobDb.getStorageUsageByPubkey(db),
    ])
    return c.json({
      default_storage_limit_bytes: DEFAULT_STORAGE_LIMIT_BYTES,
      pubkeys: pubkeys.map((p) => ({
        ...p,
        storage_used_bytes: usageMap.get(p.pubkey) ?? 0,
      })),
    })
  })

  app.post("/api/allow", async (c) => {
    const body = await c.req.json<{ pubkey?: string; expires_at?: number | null; storage_limit_bytes?: number | null }>()
    if (!body.pubkey || !/^[a-f0-9]{64}$/.test(body.pubkey)) {
      return c.json({ error: "invalid pubkey: must be 64-char hex" }, 400)
    }
    const expiresAt = body.expires_at ?? null
    await access.allow(body.pubkey, expiresAt, body.storage_limit_bytes)
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

  app.patch("/api/allow/:pubkey/storage-limit", async (c) => {
    const pubkey = c.req.param("pubkey")
    if (!pubkey || !/^[a-f0-9]{64}$/.test(pubkey)) {
      return c.json({ error: "invalid pubkey" }, 400)
    }
    const body = await c.req.json<{ storage_limit_bytes: number | null }>()
    await access.setStorageLimit(pubkey, body.storage_limit_bytes)
    return c.json({ pubkey, storage_limit_bytes: body.storage_limit_bytes })
  })

  // Invite Codes API
  app.get("/api/invite-codes", async (c) => {
    const rows = await db
      .select()
      .from(inviteCodes)
      .orderBy(desc(inviteCodes.createdAt))
    return c.json({
      invite_codes: rows.map((r) => ({
        id: r.id,
        code: r.code,
        max_uses: r.maxUses,
        use_count: r.useCount,
        expires_at: r.expiresAt,
        revoked: r.revoked,
        created_at: r.createdAt,
      })),
    })
  })

  app.post("/api/invite-codes", async (c) => {
    const body = await c.req.json<{ max_uses?: number; expires_at?: number | null }>()
    const code = generateCode()
    const maxUses = body.max_uses ?? 1
    const expiresAt = body.expires_at ?? null
    const [row] = await db.insert(inviteCodes).values({ code, maxUses, expiresAt }).returning()
    return c.json({
      id: row.id,
      code: row.code,
      max_uses: row.maxUses,
      use_count: row.useCount,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
    })
  })

  app.delete("/api/invite-codes/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10)
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400)
    await db.update(inviteCodes).set({ revoked: true }).where(eq(inviteCodes.id, id))
    return c.json({ revoked: true })
  })

  // Blobs API
  app.get("/api/blobs", async (c) => {
    const rows = await db
      .select({
        sha256: blobs.sha256,
        size: blobs.size,
        type: blobs.type,
        uploadedAt: blobs.uploadedAt,
        ownerPubkey: blobOwners.pubkey,
      })
      .from(blobs)
      .leftJoin(blobOwners, eq(blobs.sha256, blobOwners.sha256))
      .orderBy(desc(blobs.uploadedAt))
      .limit(200)

    // Group owners by sha256
    const blobMap = new Map<string, { sha256: string; size: number; type: string | null; uploaded_at: string; owners: string[] }>()
    for (const r of rows) {
      let entry = blobMap.get(r.sha256)
      if (!entry) {
        entry = { sha256: r.sha256, size: r.size, type: r.type, uploaded_at: r.uploadedAt.toISOString(), owners: [] }
        blobMap.set(r.sha256, entry)
      }
      if (r.ownerPubkey) entry.owners.push(r.ownerPubkey)
    }

    return c.json({ blobs: Array.from(blobMap.values()).slice(0, 100) })
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

  // Users API — per-user storage and event stats
  app.get("/api/users", async (c) => {
    const usageMap = await blobDb.getStorageUsageByPubkey(db)

    // Count blobs per pubkey
    const blobCountRows = await db
      .select({ pubkey: blobOwners.pubkey, count: count() })
      .from(blobOwners)
      .groupBy(blobOwners.pubkey)
    const blobCountMap = new Map<string, number>()
    for (const r of blobCountRows) blobCountMap.set(r.pubkey, Number(r.count))

    // Count events per user pubkey
    // For kind:1059 gift wraps, the real user is the p-tag recipient (pubkey is ephemeral)
    // For all other kinds, the user is the event pubkey
    const eventCountRows = await db.execute(sql`
      SELECT user_pubkey, COUNT(*) as count FROM (
        SELECT CASE
          WHEN ${events.kind} = 1059 THEN (
            SELECT et.tag_value FROM event_tags et
            WHERE et.event_id = ${events.id} AND et.tag_name = 'p'
            LIMIT 1
          )
          ELSE ${events.pubkey}
        END AS user_pubkey
        FROM ${events}
      ) sub
      WHERE user_pubkey IS NOT NULL
      GROUP BY user_pubkey
    `)
    const eventCountMap = new Map<string, number>()
    for (const r of eventCountRows as unknown as { user_pubkey: string; count: string }[]) {
      eventCountMap.set(r.user_pubkey, Number(r.count))
    }

    // Get allowlist with limits
    const allowlist = await access.list()
    const limitMap = new Map<string, number | null>()
    for (const p of allowlist) limitMap.set(p.pubkey, p.storage_limit_bytes)

    // Merge all pubkeys from all sources
    const allPubkeys = new Set([...usageMap.keys(), ...blobCountMap.keys(), ...eventCountMap.keys()])

    const users = Array.from(allPubkeys).map((pubkey) => ({
      pubkey,
      storage_used_bytes: usageMap.get(pubkey) ?? 0,
      storage_limit_bytes: limitMap.get(pubkey) ?? null,
      blob_count: blobCountMap.get(pubkey) ?? 0,
      event_count: eventCountMap.get(pubkey) ?? 0,
    }))

    // Sort by storage used descending
    users.sort((a, b) => b.storage_used_bytes - a.storage_used_bytes)

    return c.json({ users, default_storage_limit_bytes: DEFAULT_STORAGE_LIMIT_BYTES })
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
