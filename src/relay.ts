import type { ServerWebSocket } from "bun"
import type { NostrEvent, Filter, ClientMessage } from "./types"
import type { Storage } from "./storage"
import type { AccessControl } from "./access"
import type { WSData } from "./subscription"
import type { ChangeEntry } from "./types"
import { validateAndVerifyEvent, getEventKindCategory } from "./event"
import { validateLongFormEvent } from "./nip-23"
import { isDeletionEvent, validateDeletionEvent } from "./nip-09"
import { validateGiftWrap, validateSeal } from "./nip-59"
import {
  validateAuthEvent,
  isAuthorizedForFilter,
  isAuthorizedForChangesFilter,
  KIND_AUTH,
} from "./nip-42"
import {
  isValidChangesFilter,
  handleChangesRequest,
  broadcastChanges,
  removeChangesSubscription,
  removeAllChangesSubscriptions,
} from "./nip-cf"
import {
  addSubscription,
  removeSubscription,
  removeAllSubscriptions,
  broadcastEvent,
} from "./subscription"

type RelayDeps = {
  storage: Storage
  connections: Map<string, ServerWebSocket<WSData>>
  server: { publish(topic: string, data: string): void }
  relayUrl: string
  access: AccessControl
}

function send(ws: ServerWebSocket<WSData>, msg: unknown) {
  ws.send(JSON.stringify(msg))
}

/** In private mode, require authentication for all operations. */
function requirePrivateAuth(ws: ServerWebSocket<WSData>, access: AccessControl): string | null {
  if (!access.privateMode) return null
  if (ws.data.authedPubkeys.size === 0) {
    return "auth-required: this relay requires authentication"
  }
  return null
}

function isValidFilter(f: unknown): f is Filter {
  if (!f || typeof f !== "object") return false
  const filter = f as Record<string, unknown>
  for (const [key, value] of Object.entries(filter)) {
    switch (key) {
      case "ids":
      case "authors":
      case "kinds":
        if (!Array.isArray(value)) return false
        break
      case "since":
      case "until":
      case "limit":
        if (typeof value !== "number") return false
        break
      default:
        if (key[0] === "#") {
          if (!Array.isArray(value)) return false
        }
        break
    }
  }
  return true
}

export function handleMessage(
  ws: ServerWebSocket<WSData>,
  raw: string | Buffer,
  deps: RelayDeps
) {
  let msg: unknown
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString())
  } catch {
    send(ws, ["NOTICE", "error: invalid JSON"])
    return
  }

  if (!Array.isArray(msg) || msg.length < 2) {
    send(ws, ["NOTICE", "error: message must be a JSON array"])
    return
  }

  const type = msg[0]

  switch (type) {
    case "EVENT":
      handleEvent(ws, msg[1], deps)
      break
    case "AUTH":
      handleAuth(ws, msg[1], deps)
      break
    case "REQ":
      handleReq(ws, msg as [string, string, ...unknown[]], deps)
      break
    case "CHANGES":
      handleChanges(ws, msg, deps)
      break
    case "CLOSE":
      handleClose(ws, msg[1], deps)
      break
    default:
      send(ws, ["NOTICE", `error: unknown message type: ${type}`])
  }
}

function handleEvent(
  ws: ServerWebSocket<WSData>,
  event: unknown,
  deps: RelayDeps
) {
  // Private mode: require auth for writes
  const privateCheck = requirePrivateAuth(ws, deps.access)
  if (privateCheck) {
    const id = (event as any)?.id ?? ""
    send(ws, ["OK", id, false, privateCheck])
    return
  }

  const validation = validateAndVerifyEvent(event)
  if (!validation.ok) {
    const id = (event as any)?.id ?? ""
    console.log(`[EVENT] rejected id=${id.slice(0, 8)}… reason="${validation.reason}"`)
    send(ws, ["OK", id, false, validation.reason])
    return
  }

  const e = event as NostrEvent

  // NIP-42: kind:22242 events must not be stored or broadcast
  if (e.kind === KIND_AUTH) {
    send(ws, ["OK", e.id, false, "invalid: AUTH events should be sent via AUTH message, not EVENT"])
    return
  }

  console.log(`[EVENT] received kind=${e.kind} id=${e.id.slice(0, 8)}… pubkey=${e.pubkey.slice(0, 8)}…`)

  // NIP-23 validation for long-form content
  const nip23Rejection = validateLongFormEvent(e)
  if (nip23Rejection) {
    console.log(`[EVENT] rejected id=${e.id.slice(0, 8)}… reason="${nip23Rejection}"`)
    send(ws, ["OK", e.id, false, nip23Rejection])
    return
  }

  // NIP-59 validation for gift wraps and seals
  const nip59Rejection = validateGiftWrap(e) ?? validateSeal(e)
  if (nip59Rejection) {
    console.log(`[EVENT] rejected id=${e.id.slice(0, 8)}… reason="${nip59Rejection}"`)
    send(ws, ["OK", e.id, false, nip59Rejection])
    return
  }

  // NIP-09 validation for deletion requests
  if (isDeletionEvent(e)) {
    const nip09Rejection = validateDeletionEvent(e)
    if (nip09Rejection) {
      console.log(`[EVENT] rejected id=${e.id.slice(0, 8)}… reason="${nip09Rejection}"`)
      send(ws, ["OK", e.id, false, nip09Rejection])
      return
    }
  }

  const category = getEventKindCategory(e.kind)

  // Ephemeral events: broadcast but don't store
  if (category === "ephemeral") {
    console.log(`[EVENT] ephemeral id=${e.id.slice(0, 8)}… (broadcast only)`)
    send(ws, ["OK", e.id, true, ""])
    broadcastEvent(e, deps.server, deps.connections)
    return
  }

  const result = deps.storage.saveEvent(e)
  if (result.saved) {
    let allChanges: ChangeEntry[] = [...result.changes]

    // NIP-09: process deletion after storing the deletion event itself
    if (isDeletionEvent(e)) {
      const { deleted, changes: delChanges } = deps.storage.processDeletionRequest(e)
      allChanges.push(...delChanges)
      console.log(`[EVENT] deletion id=${e.id.slice(0, 8)}… deleted=${deleted} events`)
    } else {
      console.log(`[EVENT] saved id=${e.id.slice(0, 8)}… kind=${e.kind} category=${category}`)
    }

    send(ws, ["OK", e.id, true, ""])
    broadcastEvent(e, deps.server, deps.connections)

    // NIP-CF: broadcast changelog entries to live CHANGES subscribers
    broadcastChanges(allChanges, deps.storage, deps.connections, e)
  } else {
    console.log(`[EVENT] not saved id=${e.id.slice(0, 8)}… reason="${result.reason}"`)
    // Duplicates return OK with true per NIP-01 (already have it)
    const isDuplicate = result.reason?.startsWith("duplicate:")
    send(ws, ["OK", e.id, isDuplicate ?? false, result.reason ?? ""])
  }
}

function handleAuth(
  ws: ServerWebSocket<WSData>,
  event: unknown,
  deps: RelayDeps
) {
  const result = validateAuthEvent(event, ws.data.challenge, deps.relayUrl)
  const id = (event as any)?.id ?? ""

  if (result.ok && result.pubkey) {
    // Check allowlist in private mode
    if (deps.access.privateMode && !deps.access.isAllowed(result.pubkey)) {
      console.log(`[AUTH] rejected pubkey=${result.pubkey.slice(0, 8)}… reason="not on allowlist"`)
      send(ws, ["OK", id, false, "restricted: pubkey not authorized on this relay"])
      return
    }
    ws.data.authedPubkeys.add(result.pubkey)
    console.log(`[AUTH] authenticated pubkey=${result.pubkey.slice(0, 8)}…`)
    send(ws, ["OK", id, true, ""])
  } else {
    console.log(`[AUTH] rejected reason="${result.reason}"`)
    send(ws, ["OK", id, false, result.reason])
  }
}

function handleReq(
  ws: ServerWebSocket<WSData>,
  msg: [string, string, ...unknown[]],
  deps: RelayDeps
) {
  if (msg.length < 3) {
    send(ws, ["NOTICE", "error: REQ must include subscription id and at least one filter"])
    return
  }

  const subId = msg[1]
  if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
    send(ws, ["NOTICE", "error: invalid subscription id"])
    return
  }

  // Private mode: require auth for reads
  const privateCheck = requirePrivateAuth(ws, deps.access)
  if (privateCheck) {
    send(ws, ["CLOSED", subId, privateCheck])
    return
  }

  const filters: Filter[] = []
  for (let i = 2; i < msg.length; i++) {
    if (!isValidFilter(msg[i])) {
      send(ws, ["CLOSED", subId, "error: invalid filter"])
      return
    }
    filters.push(msg[i] as Filter)
  }

  // NIP-42: check auth for kind:1059 queries
  for (const filter of filters) {
    const auth = isAuthorizedForFilter(filter, ws.data.authedPubkeys)
    if (!auth.authorized) {
      send(ws, ["CLOSED", subId, auth.reason])
      return
    }
  }

  addSubscription(ws, subId, filters, deps.storage)
}

function handleChanges(
  ws: ServerWebSocket<WSData>,
  msg: unknown[],
  deps: RelayDeps
) {
  if (msg.length < 3) {
    send(ws, ["NOTICE", "error: CHANGES must include subscription id and filter"])
    return
  }

  const subId = msg[1]
  if (typeof subId !== "string" || subId.length === 0 || subId.length > 64) {
    send(ws, ["NOTICE", "error: invalid subscription id"])
    return
  }

  // Private mode: require auth for reads
  const privateCheck = requirePrivateAuth(ws, deps.access)
  if (privateCheck) {
    send(ws, ["CHANGES", subId, "ERR", privateCheck])
    return
  }

  if (!isValidChangesFilter(msg[2])) {
    send(ws, ["CHANGES", subId, "ERR", "invalid filter"])
    return
  }

  // NIP-42: check auth for kind:1059 queries
  const auth = isAuthorizedForChangesFilter(msg[2], ws.data.authedPubkeys)
  if (!auth.authorized) {
    send(ws, ["CHANGES", subId, "ERR", auth.reason])
    return
  }

  console.log(`[CHANGES] subscription id=${subId} since=${(msg[2] as any).since ?? 0} live=${(msg[2] as any).live ?? false}`)
  handleChangesRequest(ws, subId, msg[2], deps.storage)
}

function handleClose(ws: ServerWebSocket<WSData>, subId: unknown, deps?: RelayDeps) {
  if (typeof subId !== "string") {
    send(ws, ["NOTICE", "error: CLOSE requires a subscription id string"])
    return
  }
  removeSubscription(ws, subId)
  removeChangesSubscription(ws, subId)
}

export function handleOpen(ws: ServerWebSocket<WSData>, connections: Map<string, ServerWebSocket<WSData>>) {
  connections.set(ws.data.id, ws)
  // NIP-42: send AUTH challenge
  send(ws, ["AUTH", ws.data.challenge])
}

export function handleDisconnect(ws: ServerWebSocket<WSData>, connections: Map<string, ServerWebSocket<WSData>>) {
  removeAllSubscriptions(ws)
  removeAllChangesSubscriptions(ws)
  connections.delete(ws.data.id)
}
