import { Hono } from "hono"
import { setCookie, deleteCookie } from "hono/cookie"
import { desc } from "drizzle-orm"
import type { DB } from "../db"
import type { AccessControl } from "../access"
import type { Storage } from "../relay/storage"
import type { ConnectionManager } from "../connections"
import { blobs } from "../schema"
import { adminAuth } from "./middleware"
import { LoginPage } from "./views/login"
import { DashboardPage } from "./views/dashboard"
import { AllowlistPage } from "./views/allowlist"
import { BlobsPage } from "./views/blobs"
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

  // Login page (no auth required)
  app.get("/login", (c) => {
    return c.html(<LoginPage />)
  })

  app.post("/login", async (c) => {
    const body = await c.req.parseBody()
    const token = body.token as string
    if (token !== adminToken) {
      return c.html(<LoginPage error="Invalid token" />)
    }
    setCookie(c, SESSION_COOKIE, adminToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/admin",
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })
    return c.redirect("/admin")
  })

  app.get("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/admin" })
    return c.redirect("/admin/login")
  })

  // Protected routes
  app.use("/*", adminAuth(adminToken))

  // Dashboard
  app.get("/", async (c) => {
    const [eventCount, blobCount, blobTotalSize] = await Promise.all([
      storage.getEventCount(),
      blobDb.getBlobCount(db),
      blobDb.getBlobTotalSize(db),
    ])
    return c.html(
      <DashboardPage
        connectionCount={connections.size}
        eventCount={eventCount}
        blobCount={blobCount}
        blobTotalSize={blobTotalSize}
      />
    )
  })

  // Allowlist page
  app.get("/allowlist", async (c) => {
    const pubkeys = await access.list()
    return c.html(<AllowlistPage pubkeys={pubkeys} />)
  })

  app.post("/allowlist/add", async (c) => {
    const body = await c.req.parseBody()
    const pubkey = body.pubkey as string
    if (!pubkey || !/^[a-f0-9]{64}$/.test(pubkey)) {
      return c.redirect("/admin/allowlist")
    }
    await access.allow(pubkey, null)
    return c.redirect("/admin/allowlist")
  })

  app.post("/allowlist/revoke", async (c) => {
    const body = await c.req.parseBody()
    const pubkey = body.pubkey as string
    if (pubkey) {
      await access.revoke(pubkey)
    }
    return c.redirect("/admin/allowlist")
  })

  // Blobs page
  app.get("/blobs", async (c) => {
    const rows = await db
      .select({ sha256: blobs.sha256, size: blobs.size, type: blobs.type, uploadedAt: blobs.uploadedAt })
      .from(blobs)
      .orderBy(desc(blobs.uploadedAt))
      .limit(100)
    const blobList = rows.map((r) => ({
      sha256: r.sha256,
      size: r.size,
      type: r.type,
      uploaded_at: r.uploadedAt.toISOString(),
    }))
    return c.html(<BlobsPage blobs={blobList} />)
  })

  app.post("/blobs/delete", async (c) => {
    const body = await c.req.parseBody()
    const sha256 = body.sha256 as string
    if (sha256 && /^[a-f0-9]{64}$/.test(sha256)) {
      await s3.deleteBlob(sha256)
      await blobDb.deleteBlob(db, sha256)
    }
    return c.redirect("/admin/blobs")
  })

  // JSON API (for programmatic access)
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

  return app
}
