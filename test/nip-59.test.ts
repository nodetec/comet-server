import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"
import {
  validateGiftWrap,
  validateSeal,
  canDeleteGiftWrap,
  KIND_GIFT_WRAP,
  KIND_SEAL,
} from "../src/nip-59"

const sk = generateSecretKey()
const pubkey = getPublicKey(sk)

const recipientSk = generateSecretKey()
const recipientPubkey = getPublicKey(recipientSk)

// Ephemeral key for gift wrapping
const ephemeralSk = generateSecretKey()
const ephemeralPubkey = getPublicKey(ephemeralSk)

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

function createGiftWrap(
  wrapperKey: Uint8Array,
  recipientPubkey: string,
  encryptedContent = "<encrypted-seal>"
): NostrEvent {
  return sign(wrapperKey, {
    kind: KIND_GIFT_WRAP,
    content: encryptedContent,
    tags: [["p", recipientPubkey]],
  })
}

function createSeal(authorKey: Uint8Array, encryptedContent = "<encrypted-rumor>"): NostrEvent {
  return sign(authorKey, {
    kind: KIND_SEAL,
    content: encryptedContent,
    tags: [],
  })
}

// --- Unit tests ---

describe("validateGiftWrap", () => {
  test("accepts valid gift wrap", () => {
    const gw = createGiftWrap(ephemeralSk, recipientPubkey)
    expect(validateGiftWrap(gw)).toBeNull()
  })

  test("rejects gift wrap without p tag", () => {
    const gw = sign(ephemeralSk, { kind: KIND_GIFT_WRAP, content: "encrypted" })
    expect(validateGiftWrap(gw)).toContain("'p' tag")
  })

  test("skips non-gift-wrap events", () => {
    const regular = sign(sk, { kind: 1 })
    expect(validateGiftWrap(regular)).toBeNull()
  })
})

describe("validateSeal", () => {
  test("accepts valid seal", () => {
    const seal = createSeal(sk)
    expect(validateSeal(seal)).toBeNull()
  })

  test("rejects seal with tags", () => {
    const seal = sign(sk, { kind: KIND_SEAL, tags: [["p", recipientPubkey]] })
    expect(validateSeal(seal)).toContain("empty tags")
  })

  test("skips non-seal events", () => {
    const regular = sign(sk, { kind: 1 })
    expect(validateSeal(regular)).toBeNull()
  })
})

describe("canDeleteGiftWrap", () => {
  test("allows recipient to delete", () => {
    const gw = createGiftWrap(ephemeralSk, recipientPubkey)
    expect(canDeleteGiftWrap(gw, recipientPubkey)).toBe(true)
  })

  test("denies non-recipient", () => {
    const gw = createGiftWrap(ephemeralSk, recipientPubkey)
    const otherPubkey = getPublicKey(generateSecretKey())
    expect(canDeleteGiftWrap(gw, otherPubkey)).toBe(false)
  })
})

// --- Integration tests ---

describe("relay integration - NIP-59", () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  const PORT = 39127

  async function connectWs(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${PORT}`)
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

  /** Connect and authenticate as the given key. */
  async function connectAuthed(key: Uint8Array): Promise<WebSocket> {
    const ws = new WebSocket(`ws://localhost:${PORT}`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    })
    // Capture challenge
    const challenge = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        if (msg[0] === "AUTH") resolve(msg[1])
      }
    })
    // Sign AUTH event
    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", `ws://localhost:${PORT}`], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      key
    )
    ws.send(JSON.stringify(["AUTH", authEvent]))
    // Wait for OK
    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        if (msg[0] === "OK") resolve()
      }
    })
    return ws
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

  function waitForMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[][]> {
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

  beforeAll(async () => {
    const { initStorage } = await import("../src/storage")
    const { handleNip11Request } = await import("../src/nip-11")
    const { handleMessage, handleOpen, handleDisconnect } = await import("../src/relay")
    const storage = initStorage(":memory:")
    const connections = new Map()

    server = Bun.serve({
      port: PORT,
      fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const success = server.upgrade(req, { data: { id: crypto.randomUUID(), challenge: crypto.randomUUID(), authedPubkeys: new Set() } })
          return success ? undefined : new Response("fail", { status: 400 })
        }
        const accept = req.headers.get("accept") ?? ""
        if (accept.includes("application/nostr+json")) return handleNip11Request(storage.getMinSeq())
        return new Response("ok")
      },
      websocket: {
        open(ws: any) { handleOpen(ws, connections) },
        message(ws: any, message: any) { handleMessage(ws, message, { storage, connections, server: server!, relayUrl: `ws://localhost:${PORT}`, access: { isAllowed: () => true, allow: () => {}, revoke: () => false, list: () => [], privateMode: false } as any }) },
        close(ws: any) { handleDisconnect(ws, connections) },
      },
    })
  })

  afterAll(() => { server?.stop() })

  test("NIP-11 advertises NIP-59 support", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      headers: { Accept: "application/nostr+json" },
    })
    const info = (await res.json()) as any
    expect(info.supported_nips).toContain(59)
  })

  test("stores and retrieves gift wrap events", async () => {
    const ws = await connectAuthed(recipientSk)

    const gw = createGiftWrap(ephemeralSk, recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(true)

    // Query by p-tag (how recipients find their wraps)
    ws.send(JSON.stringify(["REQ", "wraps", { kinds: [KIND_GIFT_WRAP], "#p": [recipientPubkey] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(1)
    expect((events[0][2] as any).id).toBe(gw.id)

    ws.close()
  })

  test("stores seal events", async () => {
    const ws = await connectWs()

    const seal = createSeal(sk)
    ws.send(JSON.stringify(["EVENT", seal]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(true)

    ws.close()
  })

  test("rejects gift wrap without p tag", async () => {
    const ws = await connectWs()

    const bad = sign(ephemeralSk, { kind: KIND_GIFT_WRAP, content: "encrypted" })
    ws.send(JSON.stringify(["EVENT", bad]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("'p' tag")

    ws.close()
  })

  test("rejects seal with tags", async () => {
    const ws = await connectWs()

    const bad = sign(sk, { kind: KIND_SEAL, tags: [["p", recipientPubkey]] })
    ws.send(JSON.stringify(["EVENT", bad]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("empty tags")

    ws.close()
  })

  test("recipient can delete their gift wraps", async () => {
    const ws = await connectWs()

    // Publish a gift wrap addressed to recipient
    const gw = createGiftWrap(generateSecretKey(), recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw]))
    const ok1 = await waitForMessage(ws)
    expect(ok1[2]).toBe(true)

    // Recipient deletes it (using their real key, not the ephemeral wrapper key)
    const del = sign(recipientSk, { kind: 5, tags: [["e", gw.id], ["k", "1059"]] })
    ws.send(JSON.stringify(["EVENT", del]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[2]).toBe(true)

    // Gift wrap should be gone
    ws.send(JSON.stringify(["REQ", "check", { ids: [gw.id] }]))
    const msgs = await waitForMessages(ws, 1, 1000)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(0)

    ws.close()
  })

  test("non-recipient cannot delete gift wrap", async () => {
    const ws = await connectWs()

    // Publish a gift wrap addressed to recipient
    const gw = createGiftWrap(generateSecretKey(), recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw]))
    await waitForMessage(ws)

    // Random user tries to delete it
    const randomSk = generateSecretKey()
    const del = sign(randomSk, { kind: 5, tags: [["e", gw.id], ["k", "1059"]] })
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Gift wrap should still exist
    ws.send(JSON.stringify(["REQ", "still", { ids: [gw.id] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(1)

    ws.close()
  })

  test("gift wrap deletion appears in changes feed", async () => {
    const ws = await connectAuthed(recipientSk)

    // Publish and delete a gift wrap
    const gw = createGiftWrap(generateSecretKey(), recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw]))
    await waitForMessage(ws)

    const del = sign(recipientSk, { kind: 5, tags: [["e", gw.id], ["k", "1059"]] })
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Check changes feed (must include #p filter for auth)
    ws.send(JSON.stringify(["CHANGES", "gwchanges", { since: 0, kinds: [KIND_GIFT_WRAP], "#p": [recipientPubkey] }]))
    const msgs = await waitForMessages(ws, 5, 2000)

    const deleted = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "DELETED")
    const delEntry = deleted.find((m) => m[4] === gw.id)
    expect(delEntry).toBeDefined()
    expect((delEntry![5] as any).deletion_id).toBe(del.id)

    ws.close()
  })

  test("gift wrap sync via CHANGES with p-tag filter", async () => {
    const ws = await connectAuthed(recipientSk)

    // Publish wraps for two different recipients
    const gw1 = createGiftWrap(generateSecretKey(), recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw1]))
    await waitForMessage(ws)

    const otherPubkey = getPublicKey(generateSecretKey())
    const gw2 = createGiftWrap(generateSecretKey(), otherPubkey)
    ws.send(JSON.stringify(["EVENT", gw2]))
    await waitForMessage(ws)

    // Sync only recipient's wraps via CHANGES
    ws.send(JSON.stringify(["CHANGES", "mysync", { since: 0, kinds: [KIND_GIFT_WRAP], "#p": [recipientPubkey] }]))
    const msgs = await waitForMessages(ws, 5, 2000)

    const events = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    const eventIds = events.map((m) => (m[4] as any).id)

    // Should include wraps for recipient
    expect(eventIds).toContain(gw1.id)
    // Should NOT include wraps for other recipient
    expect(eventIds).not.toContain(gw2.id)

    ws.close()
  })

  test("gift wrap with d-tag replaces previous version (same p + d)", async () => {
    const ws = await connectAuthed(recipientSk)
    const dTag = "note-abc123"

    // Publish v1
    const now = Math.floor(Date.now() / 1000)
    const gw1 = sign(generateSecretKey(), {
      kind: KIND_GIFT_WRAP,
      content: "encrypted-v1",
      tags: [["p", recipientPubkey], ["d", dTag]],
      created_at: now,
    })
    ws.send(JSON.stringify(["EVENT", gw1]))
    const ok1 = await waitForMessage(ws)
    expect(ok1[2]).toBe(true)

    // Publish v2 with same p + d but newer timestamp
    const gw2 = sign(generateSecretKey(), {
      kind: KIND_GIFT_WRAP,
      content: "encrypted-v2",
      tags: [["p", recipientPubkey], ["d", dTag]],
      created_at: now + 1,
    })
    ws.send(JSON.stringify(["EVENT", gw2]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[2]).toBe(true)

    // Query — should only get v2
    ws.send(JSON.stringify(["REQ", "replaced", { kinds: [KIND_GIFT_WRAP], "#p": [recipientPubkey], "#d": [dTag] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(1)
    expect((events[0][2] as any).id).toBe(gw2.id)
    expect((events[0][2] as any).content).toBe("encrypted-v2")

    ws.close()
  })

  test("latest arrival replaces regardless of created_at (gift wrap timestamps are randomized)", async () => {
    const ws = await connectAuthed(recipientSk)
    const dTag = "note-latest-wins"

    const now = Math.floor(Date.now() / 1000)
    // Publish with a future timestamp first
    const gw1 = sign(generateSecretKey(), {
      kind: KIND_GIFT_WRAP,
      content: "first-arrival",
      tags: [["p", recipientPubkey], ["d", dTag]],
      created_at: now + 10,
    })
    ws.send(JSON.stringify(["EVENT", gw1]))
    await waitForMessage(ws)

    // Publish with an older timestamp — should still replace (latest arrival wins)
    const gw2 = sign(generateSecretKey(), {
      kind: KIND_GIFT_WRAP,
      content: "second-arrival",
      tags: [["p", recipientPubkey], ["d", dTag]],
      created_at: now,
    })
    ws.send(JSON.stringify(["EVENT", gw2]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(true)

    // The second arrival should be the one stored
    ws.send(JSON.stringify(["REQ", "latest", { kinds: [KIND_GIFT_WRAP], "#p": [recipientPubkey], "#d": [dTag] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(1)
    expect((events[0][2] as any).content).toBe("second-arrival")

    ws.close()
  })

  test("gift wrap without d-tag is not replaced", async () => {
    const ws = await connectWs()

    // Two gift wraps without d-tag — both should be stored
    const gw1 = createGiftWrap(generateSecretKey(), recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw1]))
    const ok1 = await waitForMessage(ws)
    expect(ok1[2]).toBe(true)

    const gw2 = createGiftWrap(generateSecretKey(), recipientPubkey)
    ws.send(JSON.stringify(["EVENT", gw2]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[2]).toBe(true)

    // Both should exist
    ws.send(JSON.stringify(["REQ", "both", { ids: [gw1.id, gw2.id] }]))
    const msgs = await waitForMessages(ws, 3)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(2)

    ws.close()
  })

  test("replaceable gift wrap only emits STORED changes (no DELETED for superseded)", async () => {
    const ws = await connectAuthed(recipientSk)
    const dTag = "note-changes-test"

    const now = Math.floor(Date.now() / 1000)
    const gw1 = sign(generateSecretKey(), {
      kind: KIND_GIFT_WRAP,
      content: "v1",
      tags: [["p", recipientPubkey], ["d", dTag]],
      created_at: now,
    })
    ws.send(JSON.stringify(["EVENT", gw1]))
    await waitForMessage(ws)

    const gw2 = sign(generateSecretKey(), {
      kind: KIND_GIFT_WRAP,
      content: "v2",
      tags: [["p", recipientPubkey], ["d", dTag]],
      created_at: now + 1,
    })
    ws.send(JSON.stringify(["EVENT", gw2]))
    await waitForMessage(ws)

    // Changes should show only STORED entries — no DELETED for superseded gift wraps
    ws.send(JSON.stringify(["CHANGES", "repchanges", { since: 0, kinds: [KIND_GIFT_WRAP], "#p": [recipientPubkey], "#d": [dTag] }]))
    const msgs = await waitForMessages(ws, 3, 2000)

    const deleted = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "DELETED")
    expect(deleted).toHaveLength(0)

    const stored = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    // Only the latest version should be in the STORED changes
    expect(stored.length).toBeGreaterThanOrEqual(1)
    const latestStored = stored[stored.length - 1]
    expect((latestStored[4] as any).content).toBe("v2")

    ws.close()
  })
})
