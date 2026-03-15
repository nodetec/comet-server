import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"
import {
  validateLongFormEvent,
  extractArticleMetadata,
  isLongFormEvent,
  KIND_LONG_FORM,
  KIND_LONG_FORM_DRAFT,
} from "../src/nip-23"

const sk = generateSecretKey()
const pubkey = getPublicKey(sk)

function createArticleEvent(
  overrides: Partial<{
    kind: number
    content: string
    tags: string[][]
  }> = {}
): NostrEvent {
  return finalizeEvent(
    {
      kind: overrides.kind ?? KIND_LONG_FORM,
      content:
        overrides.content ??
        "# Hello World\n\nThis is a **long-form** article with [links](https://example.com).\n\n## Section 2\n\nMore content here.",
      tags: overrides.tags ?? [
        ["d", "hello-world"],
        ["title", "Hello World"],
        ["summary", "A test article"],
        ["published_at", "1700000000"],
        ["t", "test"],
        ["t", "nostr"],
      ],
      created_at: Math.floor(Date.now() / 1000),
    },
    sk
  ) as unknown as NostrEvent
}

describe("isLongFormEvent", () => {
  test("identifies kind 30023", () => {
    expect(isLongFormEvent(createArticleEvent())).toBe(true)
  })

  test("identifies kind 30024 drafts", () => {
    expect(isLongFormEvent(createArticleEvent({ kind: KIND_LONG_FORM_DRAFT }))).toBe(true)
  })

  test("rejects other kinds", () => {
    expect(isLongFormEvent(createArticleEvent({ kind: 1 }))).toBe(false)
  })
})

describe("validateLongFormEvent", () => {
  test("accepts valid article", () => {
    expect(validateLongFormEvent(createArticleEvent())).toBeNull()
  })

  test("accepts valid draft", () => {
    const draft = createArticleEvent({
      kind: KIND_LONG_FORM_DRAFT,
      tags: [["d", "my-draft"]],
    })
    expect(validateLongFormEvent(draft)).toBeNull()
  })

  test("skips non-long-form events", () => {
    const regular = createArticleEvent({ kind: 1 })
    expect(validateLongFormEvent(regular)).toBeNull()
  })

  test("rejects missing d tag", () => {
    const event = createArticleEvent({ tags: [["title", "No D Tag"]] })
    expect(validateLongFormEvent(event)).toContain("'d' tag")
  })

  test("rejects HTML in content", () => {
    const event = createArticleEvent({
      content: "# Title\n\n<div>This has HTML</div>\n\nMore text.",
    })
    expect(validateLongFormEvent(event)).toContain("HTML")
  })

  test("rejects self-closing HTML tags", () => {
    const event = createArticleEvent({
      content: "An image: <img src='x' />\n\nDone.",
    })
    expect(validateLongFormEvent(event)).toContain("HTML")
  })

  test("allows angle brackets in code blocks", () => {
    const event = createArticleEvent({
      content: "# Code Example\n\n```html\n<div>code</div>\n```\n\nEnd.",
    })
    expect(validateLongFormEvent(event)).toBeNull()
  })

  test("allows angle brackets in inline code", () => {
    const event = createArticleEvent({
      content: "Use `<div>` for containers.",
    })
    expect(validateLongFormEvent(event)).toBeNull()
  })

  test("allows non-HTML angle brackets", () => {
    const event = createArticleEvent({
      content: "Math: 1 < 2 and 3 > 2.\n\nArrows: -> and <-",
    })
    expect(validateLongFormEvent(event)).toBeNull()
  })

  test("rejects invalid published_at", () => {
    const event = createArticleEvent({
      tags: [["d", "test"], ["published_at", "not-a-number"]],
    })
    expect(validateLongFormEvent(event)).toContain("published_at")
  })
})

describe("extractArticleMetadata", () => {
  test("extracts all metadata fields", () => {
    const event = createArticleEvent()
    const meta = extractArticleMetadata(event)

    expect(meta.dTag).toBe("hello-world")
    expect(meta.title).toBe("Hello World")
    expect(meta.summary).toBe("A test article")
    expect(meta.publishedAt).toBe(1700000000)
    expect(meta.hashtags).toEqual(["test", "nostr"])
    expect(meta.isDraft).toBe(false)
    expect(meta.image).toBeUndefined()
  })

  test("identifies drafts", () => {
    const draft = createArticleEvent({
      kind: KIND_LONG_FORM_DRAFT,
      tags: [["d", "draft-1"]],
    })
    expect(extractArticleMetadata(draft).isDraft).toBe(true)
  })

  test("handles missing optional fields", () => {
    const event = createArticleEvent({
      tags: [["d", "minimal"]],
    })
    const meta = extractArticleMetadata(event)
    expect(meta.dTag).toBe("minimal")
    expect(meta.title).toBeUndefined()
    expect(meta.summary).toBeUndefined()
    expect(meta.publishedAt).toBeUndefined()
    expect(meta.hashtags).toEqual([])
  })
})

// Integration tests: full relay round-trip for long-form events
describe("relay integration - NIP-23", () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  const PORT = 39124

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

  test("NIP-11 advertises NIP-23 support", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      headers: { Accept: "application/nostr+json" },
    })
    const info = await res.json()
    expect(info.supported_nips).toContain(23)
  })

  test("stores and retrieves a long-form article", async () => {
    const event = createArticleEvent()
    const ws = await connectWs()

    // Publish article
    ws.send(JSON.stringify(["EVENT", event]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(true)

    // Query by kind
    ws.send(JSON.stringify(["REQ", "articles", { kinds: [KIND_LONG_FORM] }]))
    const msgs = await waitForMessages(ws, 2)

    const eventMsg = msgs.find((m) => m[0] === "EVENT")!
    expect(eventMsg[2]).toHaveProperty("id", event.id)
    expect((eventMsg[2] as any).content).toContain("Hello World")

    const eose = msgs.find((m) => m[0] === "EOSE")!
    expect(eose[1]).toBe("articles")

    ws.close()
  })

  test("replaces article with same d-tag (addressable)", async () => {
    const ws = await connectWs()

    // Publish v1
    const v1 = createArticleEvent({
      content: "# Version 1",
      tags: [["d", "replaceable-article"], ["title", "V1"]],
    })
    ws.send(JSON.stringify(["EVENT", v1]))
    await waitForMessage(ws) // OK

    // Publish v2 with same d-tag (newer created_at)
    const v2 = finalizeEvent(
      {
        kind: KIND_LONG_FORM,
        content: "# Version 2\n\nUpdated content.",
        tags: [["d", "replaceable-article"], ["title", "V2"]],
        created_at: Math.floor(Date.now() / 1000) + 1,
      },
      sk
    ) as unknown as NostrEvent

    ws.send(JSON.stringify(["EVENT", v2]))
    await waitForMessage(ws) // OK

    // Query — should only get v2
    ws.send(JSON.stringify(["REQ", "latest", {
      kinds: [KIND_LONG_FORM],
      authors: [pubkey],
      "#d": ["replaceable-article"],
    }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events.length).toBe(1)
    expect((events[0][2] as any).content).toContain("Version 2")

    ws.close()
  })

  test("queries articles by hashtag", async () => {
    const ws = await connectWs()

    const event = createArticleEvent({
      tags: [
        ["d", "tagged-article"],
        ["t", "rust"],
        ["t", "programming"],
      ],
    })
    ws.send(JSON.stringify(["EVENT", event]))
    await waitForMessage(ws) // OK

    // Query by #t tag
    ws.send(JSON.stringify(["REQ", "by-tag", {
      kinds: [KIND_LONG_FORM],
      "#t": ["rust"],
    }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events.length).toBeGreaterThanOrEqual(1)
    const found = events.some((e) => (e[2] as any).id === event.id)
    expect(found).toBe(true)

    ws.close()
  })

  test("stores and retrieves drafts (kind 30024)", async () => {
    const ws = await connectWs()

    const draft = createArticleEvent({
      kind: KIND_LONG_FORM_DRAFT,
      content: "# WIP\n\nThis is a draft.",
      tags: [["d", "my-draft"], ["title", "Work in Progress"]],
    })
    ws.send(JSON.stringify(["EVENT", draft]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(true)

    // Query drafts
    ws.send(JSON.stringify(["REQ", "drafts", { kinds: [KIND_LONG_FORM_DRAFT], authors: [pubkey] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events.length).toBeGreaterThanOrEqual(1)

    ws.close()
  })

  test("rejects article with HTML in content", async () => {
    const ws = await connectWs()

    const event = createArticleEvent({
      content: "# Bad Article\n\n<script>alert('xss')</script>\n\nOops.",
    })
    ws.send(JSON.stringify(["EVENT", event]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(false)
    expect(ok[3]).toContain("HTML")

    ws.close()
  })

  test("rejects article without d tag", async () => {
    const ws = await connectWs()

    const event = createArticleEvent({ tags: [["title", "No D"]] })
    ws.send(JSON.stringify(["EVENT", event]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(false)
    expect(ok[3]).toContain("'d' tag")

    ws.close()
  })

  test("live subscription receives new articles", async () => {
    const ws = await connectWs()

    // Subscribe to long-form events
    ws.send(JSON.stringify(["REQ", "live-articles", { kinds: [KIND_LONG_FORM], "#t": ["live-test"] }]))

    // Drain historical + EOSE
    const initial = await waitForMessages(ws, 1, 1000)

    // Set up live listener
    const livePromise = waitForMessage(ws)

    // Publish from another connection
    const ws2 = await connectWs()
    const event = createArticleEvent({
      content: "# Live Article\n\nPublished in real-time.",
      tags: [["d", "live-article"], ["t", "live-test"]],
    })
    ws2.send(JSON.stringify(["EVENT", event]))
    await waitForMessage(ws2) // OK

    const liveMsg = await livePromise
    expect(liveMsg[0]).toBe("EVENT")
    expect(liveMsg[1]).toBe("live-articles")
    expect((liveMsg[2] as any).content).toContain("Live Article")

    ws.close()
    ws2.close()
  })
})
