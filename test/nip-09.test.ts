import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"
import {
  validateDeletionEvent,
  getDeletionTargetIds,
  getDeletionTargetAddrs,
  KIND_DELETION,
} from "../src/nip-09"

const sk = generateSecretKey()
const pubkey = getPublicKey(sk)

const sk2 = generateSecretKey()
const pubkey2 = getPublicKey(sk2)

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

function createDeletionEvent(
  key: Uint8Array,
  tags: string[][],
  content = ""
): NostrEvent {
  return sign(key, { kind: KIND_DELETION, tags, content })
}

// --- Unit tests ---

describe("getDeletionTargetIds", () => {
  test("extracts e tags", () => {
    const event = createDeletionEvent(sk, [
      ["e", "aaa"],
      ["e", "bbb"],
      ["k", "1"],
    ])
    expect(getDeletionTargetIds(event)).toEqual(["aaa", "bbb"])
  })

  test("returns empty for no e tags", () => {
    const event = createDeletionEvent(sk, [["k", "1"]])
    expect(getDeletionTargetIds(event)).toEqual([])
  })
})

describe("getDeletionTargetAddrs", () => {
  test("parses a tags", () => {
    const coord = `30023:${pubkey}:my-article`
    const event = createDeletionEvent(sk, [["a", coord]])
    const addrs = getDeletionTargetAddrs(event)
    expect(addrs).toHaveLength(1)
    expect(addrs[0]).toEqual({ kind: 30023, pubkey, dTag: "my-article" })
  })

  test("skips malformed a tags", () => {
    const event = createDeletionEvent(sk, [
      ["a", "invalid"],
      ["a", "30023:short:id"],
    ])
    expect(getDeletionTargetAddrs(event)).toEqual([])
  })
})

describe("validateDeletionEvent", () => {
  test("accepts valid deletion with e tags", () => {
    const event = createDeletionEvent(sk, [["e", "a".repeat(64)], ["k", "1"]])
    expect(validateDeletionEvent(event)).toBeNull()
  })

  test("accepts valid deletion with a tags", () => {
    const coord = `30023:${pubkey}:slug`
    const event = createDeletionEvent(sk, [["a", coord], ["k", "30023"]])
    expect(validateDeletionEvent(event)).toBeNull()
  })

  test("rejects deletion with no targets", () => {
    const event = createDeletionEvent(sk, [["k", "1"]])
    expect(validateDeletionEvent(event)).toContain("at least one event")
  })

  test("rejects a tag targeting different pubkey", () => {
    const coord = `30023:${pubkey2}:slug`
    const event = createDeletionEvent(sk, [["a", coord]])
    expect(validateDeletionEvent(event)).toContain("different author")
  })

  test("skips non-deletion events", () => {
    const event = sign(sk, { kind: 1 })
    expect(validateDeletionEvent(event)).toBeNull()
  })
})

// --- Integration tests ---

describe("relay integration - NIP-09", () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  const PORT = 39125

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
        if (accept.includes("application/nostr+json")) return handleNip11Request()
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

  test("NIP-11 advertises NIP-09 support", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      headers: { Accept: "application/nostr+json" },
    })
    const info = await res.json()
    expect(info.supported_nips).toContain(9)
  })

  test("deletes an event by e tag", async () => {
    const ws = await connectWs()

    // Publish an event
    const note = sign(sk, { kind: 1, content: "to be deleted" })
    ws.send(JSON.stringify(["EVENT", note]))
    const ok1 = await waitForMessage(ws)
    expect(ok1[2]).toBe(true)

    // Verify it's stored
    ws.send(JSON.stringify(["REQ", "check1", { ids: [note.id] }]))
    const check1 = await waitForMessages(ws, 2)
    const found = check1.filter((m) => m[0] === "EVENT")
    expect(found).toHaveLength(1)

    // Send deletion request
    const del = createDeletionEvent(sk, [["e", note.id], ["k", "1"]], "accidental post")
    ws.send(JSON.stringify(["EVENT", del]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[0]).toBe("OK")
    expect(ok2[2]).toBe(true)

    // Verify the event is gone
    ws.send(JSON.stringify(["REQ", "check2", { ids: [note.id] }]))
    const check2 = await waitForMessages(ws, 1, 1000)
    const remaining = check2.filter((m) => m[0] === "EVENT")
    expect(remaining).toHaveLength(0)

    ws.close()
  })

  test("deletion request event itself is still queryable", async () => {
    const ws = await connectWs()

    const note = sign(sk, { kind: 1, content: "will delete" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws)

    const del = createDeletionEvent(sk, [["e", note.id], ["k", "1"]])
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // The deletion event (kind 5) should be queryable
    ws.send(JSON.stringify(["REQ", "delquery", { kinds: [KIND_DELETION], authors: [pubkey] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events.length).toBeGreaterThanOrEqual(1)

    ws.close()
  })

  test("cannot delete another user's event", async () => {
    const ws = await connectWs()

    // User 1 publishes
    const note = sign(sk, { kind: 1, content: "user1 note" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws)

    // User 2 tries to delete it
    const del = createDeletionEvent(sk2, [["e", note.id], ["k", "1"]])
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Event should still be there
    ws.send(JSON.stringify(["REQ", "still-there", { ids: [note.id] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(1)
    expect((events[0][2] as any).id).toBe(note.id)

    ws.close()
  })

  test("prevents re-insertion of deleted events", async () => {
    const ws = await connectWs()

    // Publish and delete
    const note = sign(sk, { kind: 1, content: "once deleted" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws)

    const del = createDeletionEvent(sk, [["e", note.id], ["k", "1"]])
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Try to re-publish the same event
    ws.send(JSON.stringify(["EVENT", note]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("deleted")

    ws.close()
  })

  test("deletes addressable event by a tag", async () => {
    const ws = await connectWs()

    // Publish a long-form article
    const article = sign(sk, {
      kind: 30023,
      content: "# Article to delete",
      tags: [["d", "delete-me"], ["title", "Doomed"]],
    })
    ws.send(JSON.stringify(["EVENT", article]))
    const ok1 = await waitForMessage(ws)
    expect(ok1[2]).toBe(true)

    // Delete by `a` tag
    const coord = `30023:${pubkey}:delete-me`
    const del = createDeletionEvent(sk, [["a", coord], ["k", "30023"]])
    ws.send(JSON.stringify(["EVENT", del]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[2]).toBe(true)

    // Article should be gone
    ws.send(JSON.stringify(["REQ", "check-addr", {
      kinds: [30023],
      authors: [pubkey],
      "#d": ["delete-me"],
    }]))
    const msgs = await waitForMessages(ws, 1, 1000)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(0)

    ws.close()
  })

  test("prevents re-insertion of deleted addressable event", async () => {
    const ws = await connectWs()

    // Publish and delete an addressable event
    const now = Math.floor(Date.now() / 1000)
    const article = sign(sk, {
      kind: 30023,
      content: "# Will be deleted",
      tags: [["d", "no-reinsert"]],
      created_at: now,
    })
    ws.send(JSON.stringify(["EVENT", article]))
    await waitForMessage(ws)

    const coord = `30023:${pubkey}:no-reinsert`
    const del = sign(sk, {
      kind: KIND_DELETION,
      tags: [["a", coord], ["k", "30023"]],
      created_at: now + 1,
    })
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Try to insert an older version (created_at <= deletion timestamp)
    const oldArticle = sign(sk, {
      kind: 30023,
      content: "# Old version",
      tags: [["d", "no-reinsert"]],
      created_at: now,
    })
    ws.send(JSON.stringify(["EVENT", oldArticle]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("deleted")

    // But a newer version (after deletion timestamp) should be accepted
    const newArticle = sign(sk, {
      kind: 30023,
      content: "# New version after undeletion",
      tags: [["d", "no-reinsert"]],
      created_at: now + 2,
    })
    ws.send(JSON.stringify(["EVENT", newArticle]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[2]).toBe(true)

    ws.close()
  })

  test("rejects deletion request with no targets", async () => {
    const ws = await connectWs()

    const del = createDeletionEvent(sk, [["k", "1"]])
    ws.send(JSON.stringify(["EVENT", del]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("at least one event")

    ws.close()
  })

  test("deleting a deletion request has no effect", async () => {
    const ws = await connectWs()

    // Create a note and delete it
    const note = sign(sk, { kind: 1, content: "protected note" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws)

    const del1 = createDeletionEvent(sk, [["e", note.id], ["k", "1"]])
    ws.send(JSON.stringify(["EVENT", del1]))
    await waitForMessage(ws)

    // Try to delete the deletion event
    const del2 = createDeletionEvent(sk, [["e", del1.id], ["k", "5"]])
    ws.send(JSON.stringify(["EVENT", del2]))
    await waitForMessage(ws)

    // Original note should still be gone (deletion not reversed)
    ws.send(JSON.stringify(["REQ", "still-gone", { ids: [note.id] }]))
    const msgs = await waitForMessages(ws, 1, 1000)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events).toHaveLength(0)

    ws.close()
  })

  test("deletion content field carries reason", async () => {
    const ws = await connectWs()

    const note = sign(sk, { kind: 1, content: "oops" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws)

    const del = createDeletionEvent(sk, [["e", note.id], ["k", "1"]], "posted by accident")
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Query the deletion event and check content
    ws.send(JSON.stringify(["REQ", "delreason", { kinds: [KIND_DELETION], ids: [del.id] }]))
    const msgs = await waitForMessages(ws, 2)
    const delEvent = msgs.find((m) => m[0] === "EVENT")
    expect(delEvent).toBeDefined()
    expect((delEvent![2] as any).content).toBe("posted by accident")

    ws.close()
  })
})
