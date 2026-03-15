import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"

const sk = generateSecretKey()
const pubkey = getPublicKey(sk)

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

// --- Storage unit tests ---

describe("storage changelog", () => {
  let storage: Awaited<ReturnType<typeof import("../src/storage")["initStorage"]>>

  beforeAll(async () => {
    const { initStorage } = await import("../src/storage")
    storage = initStorage(":memory:")
  })

  afterAll(() => storage.close())

  test("regular event creates STORED changelog entry", () => {
    const event = sign(sk, { content: "hello" })
    const result = storage.saveEvent(event)
    expect(result.saved).toBe(true)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].type).toBe("STORED")
    expect(result.changes[0].eventId).toBe(event.id)
    expect(result.changes[0].kind).toBe(1)
    expect(result.changes[0].pubkey).toBe(pubkey)
    expect(result.changes[0].seq).toBeGreaterThan(0)
  })

  test("duplicate event produces no changelog entries", () => {
    const event = sign(sk, { content: "dupe test" })
    storage.saveEvent(event)
    const result = storage.saveEvent(event)
    expect(result.saved).toBe(false)
    expect(result.changes).toHaveLength(0)
  })

  test("replaceable event creates DELETED + STORED entries", () => {
    const now = Math.floor(Date.now() / 1000)
    const old = sign(sk, { kind: 0, content: '{"name":"old"}', created_at: now })
    storage.saveEvent(old)

    const newer = sign(sk, { kind: 0, content: '{"name":"new"}', created_at: now + 1 })
    const result = storage.saveEvent(newer)
    expect(result.saved).toBe(true)
    expect(result.changes).toHaveLength(2)

    const deleted = result.changes.find((c) => c.type === "DELETED")!
    const stored = result.changes.find((c) => c.type === "STORED")!
    expect(deleted.eventId).toBe(old.id)
    expect(deleted.reason).toEqual({ superseded_by: newer.id })
    expect(stored.eventId).toBe(newer.id)
    expect(stored.seq).toBeGreaterThan(deleted.seq)
  })

  test("addressable event creates DELETED + STORED entries", () => {
    const now = Math.floor(Date.now() / 1000)
    const old = sign(sk, { kind: 30023, content: "# V1", tags: [["d", "addr-test"]], created_at: now })
    storage.saveEvent(old)

    const newer = sign(sk, { kind: 30023, content: "# V2", tags: [["d", "addr-test"]], created_at: now + 1 })
    const result = storage.saveEvent(newer)
    expect(result.saved).toBe(true)

    const deleted = result.changes.find((c) => c.type === "DELETED")!
    const stored = result.changes.find((c) => c.type === "STORED")!
    expect(deleted.eventId).toBe(old.id)
    expect(deleted.reason).toEqual({ superseded_by: newer.id })
    expect(stored.eventId).toBe(newer.id)
  })

  test("NIP-09 deletion creates DELETED changelog entries", () => {
    const note = sign(sk, { content: "to delete for changelog" })
    storage.saveEvent(note)

    const del = sign(sk, { kind: 5, tags: [["e", note.id], ["k", "1"]] })
    storage.saveEvent(del)
    const result = storage.processDeletionRequest(del)

    expect(result.deleted).toBe(1)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].type).toBe("DELETED")
    expect(result.changes[0].eventId).toBe(note.id)
    expect(result.changes[0].reason).toEqual({ deletion_id: del.id })
  })

  test("queryChanges returns entries in seq order", () => {
    const changes = storage.queryChanges({ since: 0 })
    expect(changes.length).toBeGreaterThan(0)
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i].seq).toBeGreaterThan(changes[i - 1].seq)
    }
  })

  test("queryChanges respects since filter", () => {
    const all = storage.queryChanges({ since: 0 })
    const midSeq = all[Math.floor(all.length / 2)].seq
    const after = storage.queryChanges({ since: midSeq })
    expect(after.every((c) => c.seq > midSeq)).toBe(true)
  })

  test("queryChanges respects until_seq filter", () => {
    const all = storage.queryChanges({ since: 0 })
    const midSeq = all[Math.floor(all.length / 2)].seq
    const before = storage.queryChanges({ since: 0, until_seq: midSeq })
    expect(before.every((c) => c.seq <= midSeq)).toBe(true)
  })

  test("queryChanges respects limit", () => {
    const limited = storage.queryChanges({ since: 0, limit: 2 })
    expect(limited).toHaveLength(2)
  })

  test("queryChanges filters by kind", () => {
    const kind1 = storage.queryChanges({ since: 0, kinds: [1] })
    expect(kind1.every((c) => c.kind === 1)).toBe(true)
  })

  test("queryChanges filters by author", () => {
    const byAuthor = storage.queryChanges({ since: 0, authors: [pubkey] })
    expect(byAuthor.every((c) => c.pubkey === pubkey)).toBe(true)
  })

  test("getMaxSeq returns highest sequence", () => {
    const max = storage.getMaxSeq()
    const all = storage.queryChanges({ since: 0 })
    expect(max).toBe(all[all.length - 1].seq)
  })

  test("getMinSeq returns lowest sequence", () => {
    const min = storage.getMinSeq()
    const all = storage.queryChanges({ since: 0 })
    expect(min).toBe(all[0].seq)
  })

  test("tag filter excludes DELETED entries that don't match", () => {
    const tagged = sign(sk, { kind: 1, content: "tagged", tags: [["t", "alpha"]] })
    const untagged = sign(sk, { kind: 1, content: "untagged", tags: [["t", "beta"]] })
    storage.saveEvent(tagged)
    storage.saveEvent(untagged)

    // Delete both
    const del1 = sign(sk, { kind: 5, tags: [["e", tagged.id], ["k", "1"]] })
    storage.saveEvent(del1)
    storage.processDeletionRequest(del1)

    const del2 = sign(sk, { kind: 5, tags: [["e", untagged.id], ["k", "1"]] })
    storage.saveEvent(del2)
    storage.processDeletionRequest(del2)

    // Query with #t=alpha — should only get changes for the "alpha" event, not "beta"
    const filtered = storage.queryChanges({ since: 0, "#t": ["alpha"] })
    const deletedEntries = filtered.filter((c) => c.type === "DELETED")
    const deletedIds = deletedEntries.map((c) => c.eventId)
    expect(deletedIds).toContain(tagged.id)
    expect(deletedIds).not.toContain(untagged.id)
  })

  test("DELETED changelog entries carry denormalized tags", () => {
    const event = sign(sk, { kind: 1, content: "tag-check", tags: [["t", "gamma"], ["p", "a".repeat(64)]] })
    storage.saveEvent(event)
    const del = sign(sk, { kind: 5, tags: [["e", event.id], ["k", "1"]] })
    storage.saveEvent(del)
    const result = storage.processDeletionRequest(del)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].tags).toBeDefined()
    expect(result.changes[0].tags).toContainEqual(["t", "gamma"])
    expect(result.changes[0].tags).toContainEqual(["p", "a".repeat(64)])
  })

  test("replaceable supersede carries old event tags on DELETED entry", () => {
    const now = Math.floor(Date.now() / 1000) + 100
    const v1 = sign(sk, { kind: 10002, content: "", tags: [["r", "wss://relay1.example"]], created_at: now })
    storage.saveEvent(v1)

    const v2 = sign(sk, { kind: 10002, content: "", tags: [["r", "wss://relay2.example"]], created_at: now + 1 })
    const result = storage.saveEvent(v2)

    const deleted = result.changes.find((c) => c.type === "DELETED")!
    expect(deleted.tags).toContainEqual(["r", "wss://relay1.example"])
    // STORED entry should have the new tags
    const stored = result.changes.find((c) => c.type === "STORED")!
    expect(stored.tags).toContainEqual(["r", "wss://relay2.example"])
  })

  test("event insert and changelog are atomic", () => {
    // Verify that after saving, both the event and changelog entry exist
    const event = sign(sk, { kind: 1, content: "atomic-test", tags: [["t", "atomic"]] })
    const result = storage.saveEvent(event)
    expect(result.saved).toBe(true)

    // Event exists in events table
    const events = storage.queryEvents([{ ids: [event.id] }])
    expect(events).toHaveLength(1)

    // Changelog entry exists
    const changes = storage.queryChanges({ since: result.changes[0].seq - 1, limit: 1 })
    expect(changes).toHaveLength(1)
    expect(changes[0].eventId).toBe(event.id)
    expect(changes[0].type).toBe("STORED")
  })
})

// --- Integration tests ---

describe("relay integration - NIP-CF", () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  const PORT = 39126

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

  test("NIP-11 advertises CF support and changes_feed", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      headers: { Accept: "application/nostr+json" },
    })
    const info = (await res.json()) as any
    expect(info.supported_nips).toContain("CF")
    expect(info.changes_feed).toBeDefined()
    expect(typeof info.changes_feed.min_seq).toBe("number")
  })

  test("CHANGES returns STORED entries + EOSE", async () => {
    const ws = await connectWs()

    // Publish some events
    const e1 = sign(sk, { kind: 1, content: "cf-test-1" })
    const e2 = sign(sk, { kind: 1, content: "cf-test-2" })
    ws.send(JSON.stringify(["EVENT", e1]))
    await waitForMessage(ws)
    ws.send(JSON.stringify(["EVENT", e2]))
    await waitForMessage(ws)

    // Request changes from the beginning
    ws.send(JSON.stringify(["CHANGES", "sync1", { since: 0, kinds: [1] }]))
    const msgs = await waitForMessages(ws, 3, 2000) // at least 2 EVENTs + EOSE

    const events = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    const eose = msgs.find((m) => m[0] === "CHANGES" && m[2] === "EOSE")
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(eose).toBeDefined()

    // EVENT messages have seq and full event
    for (const evt of events) {
      expect(typeof evt[3]).toBe("number") // seq
      expect((evt[4] as any)).toHaveProperty("id") // full event
    }

    // Seqs should be ascending
    const seqs = events.map((e) => e[3] as number)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }

    // EOSE has last_seq
    expect(typeof eose![3]).toBe("number")
    expect(eose![3] as number).toBeGreaterThanOrEqual(seqs[seqs.length - 1])

    ws.close()
  })

  test("CHANGES returns DELETED entries for NIP-09 deletions", async () => {
    const ws = await connectWs()

    // Publish and delete
    const note = sign(sk, { kind: 1, content: "cf-delete-test" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws)

    const del = sign(sk, { kind: 5, tags: [["e", note.id], ["k", "1"]] })
    ws.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws)

    // Get all changes
    ws.send(JSON.stringify(["CHANGES", "delsync", { since: 0 }]))
    const msgs = await waitForMessages(ws, 5, 2000)

    const deleted = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "DELETED")
    expect(deleted.length).toBeGreaterThanOrEqual(1)

    const delEntry = deleted.find((m) => m[4] === note.id)
    expect(delEntry).toBeDefined()
    expect((delEntry![5] as any).deletion_id).toBe(del.id)

    ws.close()
  })

  test("CHANGES returns DELETED entries for replaceable superseding", async () => {
    const ws = await connectWs()
    const now = Math.floor(Date.now() / 1000)

    // Publish replaceable event v1
    const v1 = sign(sk, { kind: 0, content: '{"name":"v1-cf"}', created_at: now })
    ws.send(JSON.stringify(["EVENT", v1]))
    await waitForMessage(ws)

    // Publish v2 (supersedes v1)
    const v2 = sign(sk, { kind: 0, content: '{"name":"v2-cf"}', created_at: now + 1 })
    ws.send(JSON.stringify(["EVENT", v2]))
    await waitForMessage(ws)

    // Get changes
    ws.send(JSON.stringify(["CHANGES", "repsync", { since: 0, kinds: [0] }]))
    const msgs = await waitForMessages(ws, 4, 2000)

    const deleted = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "DELETED")
    const delV1 = deleted.find((m) => m[4] === v1.id)
    expect(delV1).toBeDefined()
    expect((delV1![5] as any).superseded_by).toBe(v2.id)

    ws.close()
  })

  test("incremental sync with since checkpoint", async () => {
    const ws = await connectWs()

    // Publish event 1
    const e1 = sign(sk, { kind: 7777, content: "inc-1" })
    ws.send(JSON.stringify(["EVENT", e1]))
    await waitForMessage(ws)

    // First sync — get checkpoint
    ws.send(JSON.stringify(["CHANGES", "inc1", { since: 0, kinds: [7777] }]))
    const batch1 = await waitForMessages(ws, 2, 2000)
    const eose1 = batch1.find((m) => m[0] === "CHANGES" && m[2] === "EOSE")!
    const checkpoint = eose1[3] as number

    // Publish event 2
    const e2 = sign(sk, { kind: 7777, content: "inc-2" })
    ws.send(JSON.stringify(["EVENT", e2]))
    await waitForMessage(ws)

    // Incremental sync from checkpoint
    ws.send(JSON.stringify(["CHANGES", "inc2", { since: checkpoint, kinds: [7777] }]))
    const batch2 = await waitForMessages(ws, 2, 2000)
    const events2 = batch2.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    expect(events2).toHaveLength(1)
    expect((events2[0][4] as any).id).toBe(e2.id)

    ws.close()
  })

  test("live mode streams new changes after EOSE", async () => {
    const ws = await connectWs()

    // Subscribe with live mode to a unique kind
    ws.send(JSON.stringify(["CHANGES", "live1", { since: 0, kinds: [8888], live: true }]))
    const eose = await waitForMessage(ws) // EOSE (no historical for kind 8888)
    expect(eose[2]).toBe("EOSE")

    // Set up listener for live change
    const livePromise = waitForMessage(ws)

    // Publish from another connection
    const ws2 = await connectWs()
    const event = sign(sk, { kind: 8888, content: "live-cf" })
    ws2.send(JSON.stringify(["EVENT", event]))
    await waitForMessage(ws2) // OK

    // ws1 should receive the live CHANGES EVENT
    const liveMsg = await livePromise
    expect(liveMsg[0]).toBe("CHANGES")
    expect(liveMsg[1]).toBe("live1")
    expect(liveMsg[2]).toBe("EVENT")
    expect(typeof liveMsg[3]).toBe("number") // seq
    expect((liveMsg[4] as any).id).toBe(event.id)

    ws.close()
    ws2.close()
  })

  test("live mode streams DELETED changes", async () => {
    const ws = await connectWs()
    const ws2 = await connectWs()

    // Subscribe live to kind 6666
    ws.send(JSON.stringify(["CHANGES", "livedel", { since: 0, kinds: [6666], live: true }]))
    await waitForMessage(ws) // EOSE

    // Set up listener BEFORE publishing (to avoid race)
    const storedPromise = waitForMessage(ws)

    // Publish an event
    const note = sign(sk, { kind: 6666, content: "live-delete-cf" })
    ws2.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws2) // OK

    // Receive the STORED change on ws1
    const storedMsg = await storedPromise
    expect(storedMsg[2]).toBe("EVENT")

    // Set up listener for deletion BEFORE sending delete
    const delPromise = waitForMessage(ws)

    // Delete the event
    const del = sign(sk, { kind: 5, tags: [["e", note.id], ["k", "6666"]] })
    ws2.send(JSON.stringify(["EVENT", del]))
    await waitForMessage(ws2) // OK

    // ws1 should receive the DELETED change
    const delMsg = await delPromise
    expect(delMsg[0]).toBe("CHANGES")
    expect(delMsg[1]).toBe("livedel")
    expect(delMsg[2]).toBe("DELETED")
    expect(delMsg[4]).toBe(note.id)
    expect((delMsg[5] as any).deletion_id).toBe(del.id)

    ws.close()
    ws2.close()
  })

  test("CLOSE stops live changes", async () => {
    const ws = await connectWs()

    // Subscribe live
    ws.send(JSON.stringify(["CHANGES", "closeme", { since: 0, kinds: [5555], live: true }]))
    await waitForMessage(ws) // EOSE

    // Close the subscription
    ws.send(JSON.stringify(["CLOSE", "closeme"]))

    // Publish an event
    const ws2 = await connectWs()
    const note = sign(sk, { kind: 5555, content: "after close" })
    ws2.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws2) // OK

    // ws1 should NOT receive anything
    const msgs = await waitForMessages(ws, 1, 500)
    const changeMsgs = msgs.filter((m) => m[0] === "CHANGES" && m[1] === "closeme")
    expect(changeMsgs).toHaveLength(0)

    ws.close()
    ws2.close()
  })

  test("until_seq bounds the response", async () => {
    const ws = await connectWs()

    // Publish a few events
    for (let i = 0; i < 3; i++) {
      const e = sign(sk, { kind: 4444, content: `until-${i}` })
      ws.send(JSON.stringify(["EVENT", e]))
      await waitForMessage(ws)
    }

    // Get all changes to find a midpoint
    ws.send(JSON.stringify(["CHANGES", "all", { since: 0, kinds: [4444] }]))
    const allMsgs = await waitForMessages(ws, 4, 2000)
    const allEvents = allMsgs.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    const midSeq = allEvents[1][3] as number

    // Query with until_seq
    ws.send(JSON.stringify(["CHANGES", "bounded", { since: 0, kinds: [4444], until_seq: midSeq }]))
    const bounded = await waitForMessages(ws, 3, 2000)
    const boundedEvents = bounded.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    expect(boundedEvents.every((e) => (e[3] as number) <= midSeq)).toBe(true)

    ws.close()
  })

  test("limit caps the number of returned changes", async () => {
    const ws = await connectWs()

    // Publish events
    for (let i = 0; i < 5; i++) {
      const e = sign(sk, { kind: 3333, content: `limit-${i}` })
      ws.send(JSON.stringify(["EVENT", e]))
      await waitForMessage(ws)
    }

    // Query with limit
    ws.send(JSON.stringify(["CHANGES", "lim", { since: 0, kinds: [3333], limit: 2 }]))
    const msgs = await waitForMessages(ws, 3, 2000)
    const events = msgs.filter((m) => m[0] === "CHANGES" && m[2] === "EVENT")
    expect(events).toHaveLength(2)

    ws.close()
  })

  test("invalid filter returns ERR", async () => {
    const ws = await connectWs()

    ws.send(JSON.stringify(["CHANGES", "bad", { since: "not-a-number" }]))
    const msg = await waitForMessage(ws)
    expect(msg[0]).toBe("CHANGES")
    expect(msg[2]).toBe("ERR")

    ws.close()
  })

  test("empty EOSE last_seq is global max even with no matches", async () => {
    const ws = await connectWs()

    // Publish a kind:1 event to advance the global seq
    const e = sign(sk, { kind: 1, content: "advance seq" })
    ws.send(JSON.stringify(["EVENT", e]))
    await waitForMessage(ws)

    // Query for a kind that doesn't exist
    ws.send(JSON.stringify(["CHANGES", "empty", { since: 0, kinds: [99999] }]))
    const msgs = await waitForMessages(ws, 1, 2000)
    const eose = msgs.find((m) => m[0] === "CHANGES" && m[2] === "EOSE")
    expect(eose).toBeDefined()
    expect(eose![3] as number).toBeGreaterThan(0)

    ws.close()
  })
})
