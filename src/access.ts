import { Database } from "bun:sqlite"

export interface AccessControl {
  /** Check if a pubkey is allowed. Always true when private mode is off. */
  isAllowed(pubkey: string): boolean
  /** Add or extend access for a pubkey. */
  allow(pubkey: string, expiresAt: number | null): void
  /** Revoke access for a pubkey. */
  revoke(pubkey: string): boolean
  /** List all allowed pubkeys with their expiry. */
  list(): Array<{ pubkey: string; expires_at: number | null }>
  /** Whether private mode is enabled. */
  readonly privateMode: boolean
}

export function initAccessControl(db: Database, privateMode: boolean): AccessControl {
  db.exec(`
    CREATE TABLE IF NOT EXISTS allowed_pubkeys (
      pubkey      TEXT PRIMARY KEY,
      expires_at  INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)

  const selectAllowed = db.prepare(
    "SELECT 1 FROM allowed_pubkeys WHERE pubkey = ? AND (expires_at IS NULL OR expires_at > unixepoch())"
  )
  const upsertAllowed = db.prepare(
    "INSERT INTO allowed_pubkeys (pubkey, expires_at) VALUES (?, ?) ON CONFLICT(pubkey) DO UPDATE SET expires_at = excluded.expires_at"
  )
  const deleteAllowed = db.prepare("DELETE FROM allowed_pubkeys WHERE pubkey = ?")
  const selectAll = db.prepare(
    "SELECT pubkey, expires_at FROM allowed_pubkeys ORDER BY created_at"
  )

  function isAllowed(pubkey: string): boolean {
    if (!privateMode) return true
    return selectAllowed.get(pubkey) != null
  }

  function allow(pubkey: string, expiresAt: number | null): void {
    upsertAllowed.run(pubkey, expiresAt)
  }

  function revoke(pubkey: string): boolean {
    const result = deleteAllowed.run(pubkey)
    return result.changes > 0
  }

  function list(): Array<{ pubkey: string; expires_at: number | null }> {
    return selectAll.all() as Array<{ pubkey: string; expires_at: number | null }>
  }

  return { isAllowed, allow, revoke, list, privateMode }
}

/**
 * Handle admin API HTTP requests.
 * Routes: POST /admin/allow, DELETE /admin/allow/:pubkey, GET /admin/allow
 */
export function handleAdminRequest(
  req: Request,
  access: AccessControl,
  adminToken: string
): Response | null {
  const url = new URL(req.url)
  if (!url.pathname.startsWith("/admin/")) return null

  // Verify admin token
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${adminToken}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  // GET /admin/allow — list all allowed pubkeys
  if (req.method === "GET" && url.pathname === "/admin/allow") {
    const list = access.list()
    return new Response(JSON.stringify({ pubkeys: list }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  // POST /admin/allow — add/extend a pubkey
  if (req.method === "POST" && url.pathname === "/admin/allow") {
    return handleAllowPost(req, access)
  }

  // DELETE /admin/allow/:pubkey — revoke a pubkey
  if (req.method === "DELETE" && url.pathname.startsWith("/admin/allow/")) {
    const pubkey = url.pathname.slice("/admin/allow/".length)
    if (!pubkey || !/^[a-f0-9]{64}$/.test(pubkey)) {
      return new Response(JSON.stringify({ error: "invalid pubkey" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }
    const revoked = access.revoke(pubkey)
    return new Response(JSON.stringify({ revoked }), {
      status: revoked ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  })
}

async function handleAllowPost(req: Request, access: AccessControl): Promise<Response> {
  let body: { pubkey?: string; expires_at?: number | null }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  if (!body.pubkey || !/^[a-f0-9]{64}$/.test(body.pubkey)) {
    return new Response(JSON.stringify({ error: "invalid pubkey: must be 64-char hex" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  const expiresAt = body.expires_at ?? null
  access.allow(body.pubkey, expiresAt)

  return new Response(JSON.stringify({ allowed: true, pubkey: body.pubkey, expires_at: expiresAt }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
