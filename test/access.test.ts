import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"
import { initAccessControl } from "../src/access"

const sk = generateSecretKey()
const pubkey = getPublicKey(sk)

const otherSk = generateSecretKey()
const otherPubkey = getPublicKey(otherSk)

function sign(
  key: Uint8Array,
  overrides: Partial<{ kind: number; content: string; tags: string[][]; created_at: number }> = {}
): NostrEvent {
  return finalizeEvent(
    {
      kind: overrides.kind ?? 1,
      content: overrides.content ?? "",
      tags: overrides.tags ?? [],
      created_at: overrides.created_at ?? Math.floor(Date.now() / 1000),
    },
    key
  ) as unknown as NostrEvent
}

// --- Unit tests ---

describe("AccessControl", () => {
  test("open mode allows everyone", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, false)
    expect(access.isAllowed(pubkey)).toBe(true)
    expect(access.isAllowed(otherPubkey)).toBe(true)
    expect(access.privateMode).toBe(false)
    db.close()
  })

  test("private mode rejects unknown pubkeys", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    expect(access.isAllowed(pubkey)).toBe(false)
    expect(access.privateMode).toBe(true)
    db.close()
  })

  test("allow adds a pubkey", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    access.allow(pubkey, null)
    expect(access.isAllowed(pubkey)).toBe(true)
    expect(access.isAllowed(otherPubkey)).toBe(false)
    db.close()
  })

  test("allow with expiry works until expired", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    const futureTs = Math.floor(Date.now() / 1000) + 3600
    access.allow(pubkey, futureTs)
    expect(access.isAllowed(pubkey)).toBe(true)
    db.close()
  })

  test("expired pubkey is rejected", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    const pastTs = Math.floor(Date.now() / 1000) - 1
    access.allow(pubkey, pastTs)
    expect(access.isAllowed(pubkey)).toBe(false)
    db.close()
  })

  test("revoke removes a pubkey", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    access.allow(pubkey, null)
    expect(access.isAllowed(pubkey)).toBe(true)
    const revoked = access.revoke(pubkey)
    expect(revoked).toBe(true)
    expect(access.isAllowed(pubkey)).toBe(false)
    db.close()
  })

  test("revoke returns false for unknown pubkey", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    expect(access.revoke(pubkey)).toBe(false)
    db.close()
  })

  test("list returns all pubkeys", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    access.allow(pubkey, null)
    access.allow(otherPubkey, 1700000000)
    const list = access.list()
    expect(list).toHaveLength(2)
    expect(list.find((e) => e.pubkey === pubkey)?.expires_at).toBeNull()
    expect(list.find((e) => e.pubkey === otherPubkey)?.expires_at).toBe(1700000000)
    db.close()
  })

  test("allow upserts (extends) expiry", () => {
    const db = new Database(":memory:")
    const access = initAccessControl(db, true)
    access.allow(pubkey, 1700000000)
    access.allow(pubkey, 1800000000) // extend
    const list = access.list()
    expect(list.find((e) => e.pubkey === pubkey)?.expires_at).toBe(1800000000)
    db.close()
  })
})

// --- Integration tests ---

describe("private mode relay integration", () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  const PORT = 39129
  const RELAY_URL = `ws://localhost:${PORT}`
  const ADMIN_TOKEN = "test-admin-secret"
  let access: ReturnType<typeof initAccessControl>

  async function connectRaw(): Promise<{ ws: WebSocket; challenge: string }> {
    const ws = new WebSocket(RELAY_URL)
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

  async function authenticate(ws: WebSocket, challenge: string, key: Uint8Array): Promise<unknown[]> {
    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      key
    )
    ws.send(JSON.stringify(["AUTH", authEvent]))
    return new Promise((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string))
    })
  }

  function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
      ws.onmessage = (e) => {
        clearTimeout(timer)
        resolve(JSON.parse(e.data as string))
      }
    })
  }

  beforeAll(async () => {
    const { initStorage } = await import("../src/storage")
    const { handleNip11Request } = await import("../src/nip-11")
    const { handleMessage, handleOpen, handleDisconnect } = await import("../src/relay")
    const { initAccessControl: initAC, handleAdminRequest } = await import("../src/access")
    const storage = initStorage(":memory:")
    access = initAC(storage.db, true) // private mode ON
    const connections = new Map()

    server = Bun.serve({
      port: PORT,
      async fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const success = server.upgrade(req, { data: { id: crypto.randomUUID(), challenge: crypto.randomUUID(), authedPubkeys: new Set() } })
          return success ? undefined : new Response("fail", { status: 400 })
        }
        // Admin API
        const adminResponse = handleAdminRequest(req, access, ADMIN_TOKEN)
        if (adminResponse) return adminResponse
        const accept = req.headers.get("accept") ?? ""
        if (accept.includes("application/nostr+json")) return handleNip11Request(storage.getMinSeq())
        return new Response("ok")
      },
      websocket: {
        open(ws: any) { handleOpen(ws, connections) },
        message(ws: any, message: any) { handleMessage(ws, message, { storage, connections, server: server!, relayUrl: RELAY_URL, access }) },
        close(ws: any) { handleDisconnect(ws, connections) },
      },
    })
  })

  afterAll(() => { server?.stop() })

  // --- Admin API tests ---

  test("admin API rejects without token", async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/allow`)
    expect(res.status).toBe(401)
  })

  test("admin API rejects wrong token", async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/allow`, {
      headers: { Authorization: "Bearer wrong" },
    })
    expect(res.status).toBe(401)
  })

  test("admin API: POST /admin/allow adds a pubkey", async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/allow`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pubkey, expires_at: null }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.allowed).toBe(true)
    expect(body.pubkey).toBe(pubkey)
  })

  test("admin API: GET /admin/allow lists pubkeys", async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/allow`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.pubkeys.length).toBeGreaterThanOrEqual(1)
    expect(body.pubkeys.some((p: any) => p.pubkey === pubkey)).toBe(true)
  })

  test("admin API: POST validates pubkey format", async () => {
    const res = await fetch(`http://localhost:${PORT}/admin/allow`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pubkey: "invalid" }),
    })
    expect(res.status).toBe(400)
  })

  test("admin API: DELETE /admin/allow/:pubkey revokes", async () => {
    // Add then revoke otherPubkey
    await fetch(`http://localhost:${PORT}/admin/allow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: otherPubkey }),
    })
    const res = await fetch(`http://localhost:${PORT}/admin/allow/${otherPubkey}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.revoked).toBe(true)
  })

  // --- Private mode WebSocket tests ---

  test("unauthenticated EVENT is rejected in private mode", async () => {
    const { ws } = await connectRaw()

    const note = sign(sk, { kind: 1, content: "hello" })
    ws.send(JSON.stringify(["EVENT", note]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("auth-required")

    ws.close()
  })

  test("unauthenticated REQ is rejected in private mode", async () => {
    const { ws } = await connectRaw()

    ws.send(JSON.stringify(["REQ", "sub", { kinds: [1] }]))
    const msg = await waitForMessage(ws)
    expect(msg[0]).toBe("CLOSED")
    expect((msg[2] as string)).toContain("auth-required")

    ws.close()
  })

  test("non-allowed pubkey AUTH is rejected", async () => {
    // otherPubkey was revoked above
    const { ws, challenge } = await connectRaw()

    const ok = await authenticate(ws, challenge, otherSk)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("not authorized")

    ws.close()
  })

  test("allowed pubkey can authenticate and write", async () => {
    // pubkey was allowed above
    const { ws, challenge } = await connectRaw()

    const ok = await authenticate(ws, challenge, sk)
    expect(ok[2]).toBe(true)

    // Now can write
    const note = sign(sk, { kind: 1, content: "private note" })
    ws.send(JSON.stringify(["EVENT", note]))
    const eventOk = await waitForMessage(ws)
    expect(eventOk[2]).toBe(true)

    ws.close()
  })

  test("allowed pubkey can subscribe", async () => {
    const { ws, challenge } = await connectRaw()
    await authenticate(ws, challenge, sk)

    ws.send(JSON.stringify(["REQ", "sub", { kinds: [1] }]))
    const msg = await waitForMessage(ws)
    // Should get EVENT or EOSE, not CLOSED
    expect(["EVENT", "EOSE"]).toContain(msg[0])

    ws.close()
  })

  test("subscription expires with allowlist", async () => {
    // Add a pubkey with past expiry
    const expiredSk = generateSecretKey()
    const expiredPubkey = getPublicKey(expiredSk)
    const pastTs = Math.floor(Date.now() / 1000) - 1
    access.allow(expiredPubkey, pastTs)

    const { ws, challenge } = await connectRaw()
    const ok = await authenticate(ws, challenge, expiredSk)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("not authorized")

    ws.close()
  })

  test("admin can extend expiry", async () => {
    const extSk = generateSecretKey()
    const extPubkey = getPublicKey(extSk)

    // Add with future expiry
    const futureTs = Math.floor(Date.now() / 1000) + 3600
    access.allow(extPubkey, futureTs)

    const { ws, challenge } = await connectRaw()
    const ok = await authenticate(ws, challenge, extSk)
    expect(ok[2]).toBe(true)

    ws.close()
  })
})
