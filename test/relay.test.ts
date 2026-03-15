import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"

let server: ReturnType<typeof Bun.serve> | null = null
const PORT = 39123 // Use a high port to avoid conflicts

function createSignedEvent(
  sk: Uint8Array,
  overrides: Partial<{ kind: number; content: string; tags: string[][] }> = {}
) {
  return finalizeEvent(
    {
      kind: overrides.kind ?? 1,
      content: overrides.content ?? "test note",
      tags: overrides.tags ?? [],
      created_at: Math.floor(Date.now() / 1000),
    },
    sk
  ) as unknown as NostrEvent
}

async function connectWs(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${PORT}`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(e)
  })
  // Drain AUTH challenge
  await new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string)
      if (msg[0] === "AUTH") resolve()
    }
  })
  return ws
}

function waitForMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = []
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

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
    ws.onmessage = (e) => {
      clearTimeout(timer)
      resolve(JSON.parse(e.data as string))
    }
  })
}

// Start the relay server before tests
beforeAll(async () => {
  // Dynamic import to avoid top-level side effects
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
      if (accept.includes("application/nostr+json")) {
        return handleNip11Request()
      }
      return new Response("ok")
    },
    websocket: {
      open(ws: any) {
        handleOpen(ws, connections)
      },
      message(ws: any, message: any) {
        handleMessage(ws, message, { storage, connections, server: server!, relayUrl: `ws://localhost:${PORT}`, access: { isAllowed: () => true, allow: () => {}, revoke: () => false, list: () => [], privateMode: false } as any })
      },
      close(ws: any) {
        handleDisconnect(ws, connections)
      },
    },
  })
})

afterAll(() => {
  server?.stop()
})

describe("relay integration", () => {
  test("NIP-11 relay info via HTTP", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      headers: { Accept: "application/nostr+json" },
    })
    expect(res.status).toBe(200)
    const info = await res.json()
    expect(info.name).toBe("nostr-relay-bun")
    expect(info.supported_nips).toContain(1)
  })

  test("EVENT → OK → REQ returns event + EOSE", async () => {
    const sk = generateSecretKey()
    const event = createSignedEvent(sk)

    const ws = await connectWs()

    // Send event
    ws.send(JSON.stringify(["EVENT", event]))
    const okMsg = (await waitForMessage(ws)) as unknown[]
    expect(okMsg[0]).toBe("OK")
    expect(okMsg[1]).toBe(event.id)
    expect(okMsg[2]).toBe(true)

    // Subscribe
    ws.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]))
    const msgs = await waitForMessages(ws, 2)

    const eventMsg = msgs.find((m: any) => m[0] === "EVENT") as unknown[]
    const eoseMsg = msgs.find((m: any) => m[0] === "EOSE") as unknown[]
    expect(eventMsg).toBeDefined()
    expect(eventMsg![2]).toHaveProperty("id", event.id)
    expect(eoseMsg).toBeDefined()
    expect(eoseMsg![1]).toBe("sub1")

    ws.close()
  })

  test("live subscription receives new events", async () => {
    const sk = generateSecretKey()

    const ws = await connectWs()

    // Subscribe first — use a unique kind to avoid historical events
    ws.send(JSON.stringify(["REQ", "live", { kinds: [9999] }]))

    // Wait for EOSE (no historical events for kind 9999)
    const eoseMsg = (await waitForMessage(ws)) as unknown[]
    expect(eoseMsg[0]).toBe("EOSE")

    // Now set up listener for live event BEFORE sending
    const livePromise = waitForMessage(ws)

    // Send event from another connection
    const ws2 = await connectWs()
    const event = createSignedEvent(sk, { kind: 9999, content: "live event" })
    ws2.send(JSON.stringify(["EVENT", event]))
    await waitForMessage(ws2) // OK

    // ws1 should receive the live event
    const liveMsg = (await livePromise) as unknown[]
    expect(liveMsg[0]).toBe("EVENT")
    expect(liveMsg[1]).toBe("live")
    expect((liveMsg[2] as any).content).toBe("live event")

    ws.close()
    ws2.close()
  })

  test("CLOSE removes subscription", async () => {
    const ws = await connectWs()
    ws.send(JSON.stringify(["REQ", "temp", { kinds: [1] }]))

    // Drain EOSE + any events
    await waitForMessages(ws, 1, 1000)

    ws.send(JSON.stringify(["CLOSE", "temp"]))

    // Send an event — should NOT receive it on "temp"
    const sk = generateSecretKey()
    const event = createSignedEvent(sk, { content: "after close" })

    const ws2 = await connectWs()
    ws2.send(JSON.stringify(["EVENT", event]))
    await waitForMessage(ws2)

    // ws1 should not receive anything (use short timeout)
    const msgs = await waitForMessages(ws, 1, 500)
    const tempMsgs = (msgs as any[]).filter(
      (m) => m[0] === "EVENT" && m[1] === "temp"
    )
    expect(tempMsgs.length).toBe(0)

    ws.close()
    ws2.close()
  })

  test("invalid event returns OK false", async () => {
    const ws = await connectWs()

    ws.send(
      JSON.stringify([
        "EVENT",
        { id: "bad", pubkey: "bad", created_at: 0, kind: 1, tags: [], content: "", sig: "bad" },
      ])
    )
    const msg = (await waitForMessage(ws)) as unknown[]
    expect(msg[0]).toBe("OK")
    expect(msg[2]).toBe(false)

    ws.close()
  })

  test("invalid JSON returns NOTICE", async () => {
    const ws = await connectWs()
    ws.send("not json{{{")
    const msg = (await waitForMessage(ws)) as unknown[]
    expect(msg[0]).toBe("NOTICE")

    ws.close()
  })
})
