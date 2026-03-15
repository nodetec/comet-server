import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure"
import type { NostrEvent } from "../src/types"
import { KIND_GIFT_WRAP } from "../src/nip-59"

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

let server: ReturnType<typeof Bun.serve> | null = null
const PORT = 39128
const RELAY_URL = `ws://localhost:${PORT}`

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

async function connectAuthed(key: Uint8Array): Promise<WebSocket> {
  const { ws, challenge } = await connectRaw()
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
      message(ws: any, message: any) { handleMessage(ws, message, { storage, connections, server: server!, relayUrl: RELAY_URL, access: { isAllowed: () => true, allow: () => {}, revoke: () => false, list: () => [], privateMode: false } as any }) },
      close(ws: any) { handleDisconnect(ws, connections) },
    },
  })
})

afterAll(() => { server?.stop() })

describe("NIP-42 AUTH", () => {
  test("NIP-11 advertises NIP-42 support", async () => {
    const res = await fetch(`http://localhost:${PORT}`, {
      headers: { Accept: "application/nostr+json" },
    })
    const info = (await res.json()) as any
    expect(info.supported_nips).toContain(42)
  })

  test("relay sends AUTH challenge on connect", async () => {
    const { ws, challenge } = await connectRaw()
    expect(typeof challenge).toBe("string")
    expect(challenge.length).toBeGreaterThan(0)
    ws.close()
  })

  test("valid AUTH returns OK true", async () => {
    const { ws, challenge } = await connectRaw()

    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    )
    ws.send(JSON.stringify(["AUTH", authEvent]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(true)

    ws.close()
  })

  test("AUTH with wrong challenge fails", async () => {
    const { ws, challenge } = await connectRaw()

    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", "wrong-challenge"]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    )
    ws.send(JSON.stringify(["AUTH", authEvent]))
    const ok = await waitForMessage(ws)
    expect(ok[0]).toBe("OK")
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("challenge")

    ws.close()
  })

  test("AUTH with wrong kind fails", async () => {
    const { ws, challenge } = await connectRaw()

    const authEvent = finalizeEvent(
      {
        kind: 1, // wrong kind
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    )
    ws.send(JSON.stringify(["AUTH", authEvent]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("kind 22242")

    ws.close()
  })

  test("AUTH with expired timestamp fails", async () => {
    const { ws, challenge } = await connectRaw()

    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000) - 700, // > 10 min ago
      },
      sk
    )
    ws.send(JSON.stringify(["AUTH", authEvent]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("timestamp")

    ws.close()
  })

  test("kind:22242 via EVENT is rejected", async () => {
    const { ws, challenge } = await connectRaw()

    const authEvent = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    )
    // Send via EVENT instead of AUTH
    ws.send(JSON.stringify(["EVENT", authEvent]))
    const ok = await waitForMessage(ws)
    expect(ok[2]).toBe(false)
    expect((ok[3] as string)).toContain("AUTH message")

    ws.close()
  })

  test("multiple pubkeys can authenticate on same connection", async () => {
    const { ws, challenge } = await connectRaw()

    // Auth as pubkey 1
    const auth1 = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    )
    ws.send(JSON.stringify(["AUTH", auth1]))
    const ok1 = await waitForMessage(ws)
    expect(ok1[2]).toBe(true)

    // Auth as pubkey 2
    const auth2 = finalizeEvent(
      {
        kind: 22242,
        content: "",
        tags: [["relay", RELAY_URL], ["challenge", challenge]],
        created_at: Math.floor(Date.now() / 1000),
      },
      otherSk
    )
    ws.send(JSON.stringify(["AUTH", auth2]))
    const ok2 = await waitForMessage(ws)
    expect(ok2[2]).toBe(true)

    ws.close()
  })
})

describe("NIP-42 access control for gift wraps", () => {
  test("unauthenticated REQ for kind:1059 returns auth-required", async () => {
    const { ws } = await connectRaw()

    ws.send(JSON.stringify(["REQ", "gw", { kinds: [KIND_GIFT_WRAP], "#p": [pubkey] }]))
    const msg = await waitForMessage(ws)
    expect(msg[0]).toBe("CLOSED")
    expect(msg[1]).toBe("gw")
    expect((msg[2] as string)).toContain("auth-required")

    ws.close()
  })

  test("authenticated REQ for own gift wraps succeeds", async () => {
    const ws = await connectAuthed(sk)

    // Publish a gift wrap for ourselves
    const ephSk = generateSecretKey()
    const gw = sign(ephSk, { kind: KIND_GIFT_WRAP, content: "encrypted", tags: [["p", pubkey]] })
    ws.send(JSON.stringify(["EVENT", gw]))
    await waitForMessage(ws) // OK

    // Query our own wraps
    ws.send(JSON.stringify(["REQ", "mine", { kinds: [KIND_GIFT_WRAP], "#p": [pubkey] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events.length).toBeGreaterThanOrEqual(1)

    ws.close()
  })

  test("authenticated REQ for someone else's gift wraps returns restricted", async () => {
    const ws = await connectAuthed(sk)

    ws.send(JSON.stringify(["REQ", "theirs", { kinds: [KIND_GIFT_WRAP], "#p": [otherPubkey] }]))
    const msg = await waitForMessage(ws)
    expect(msg[0]).toBe("CLOSED")
    expect((msg[2] as string)).toContain("restricted")

    ws.close()
  })

  test("kind:1059 REQ without #p filter returns restricted", async () => {
    const ws = await connectAuthed(sk)

    ws.send(JSON.stringify(["REQ", "nop", { kinds: [KIND_GIFT_WRAP] }]))
    const msg = await waitForMessage(ws)
    expect(msg[0]).toBe("CLOSED")
    expect((msg[2] as string)).toContain("restricted")

    ws.close()
  })

  test("unauthenticated CHANGES for kind:1059 returns auth-required", async () => {
    const { ws } = await connectRaw()

    ws.send(JSON.stringify(["CHANGES", "gw", { since: 0, kinds: [KIND_GIFT_WRAP], "#p": [pubkey] }]))
    const msg = await waitForMessage(ws)
    expect(msg[0]).toBe("CHANGES")
    expect(msg[2]).toBe("ERR")
    expect((msg[3] as string)).toContain("auth-required")

    ws.close()
  })

  test("authenticated CHANGES for own gift wraps succeeds", async () => {
    const ws = await connectAuthed(sk)

    ws.send(JSON.stringify(["CHANGES", "mysync", { since: 0, kinds: [KIND_GIFT_WRAP], "#p": [pubkey] }]))
    const msg = await waitForMessage(ws)
    // Should get EOSE (no stored gift wraps), not ERR
    expect(msg[0]).toBe("CHANGES")
    expect(msg[1]).toBe("mysync")
    // Could be EOSE or EVENT depending on prior test state
    expect(["EOSE", "EVENT"]).toContain(msg[2])

    ws.close()
  })

  test("non-gift-wrap queries work without auth", async () => {
    const { ws } = await connectRaw()

    // Publish a regular event
    const note = sign(sk, { kind: 1, content: "public note" })
    ws.send(JSON.stringify(["EVENT", note]))
    await waitForMessage(ws) // OK

    // Query without auth — should work for non-gift-wrap kinds
    ws.send(JSON.stringify(["REQ", "pub", { kinds: [1] }]))
    const msgs = await waitForMessages(ws, 2)
    const events = msgs.filter((m) => m[0] === "EVENT")
    expect(events.length).toBeGreaterThanOrEqual(1)

    ws.close()
  })
})
