import type { ServerWebSocket } from "bun"
import type { NostrEvent, Filter, RelayMessage } from "./types"
import type { Storage } from "./storage"
import { matchFilters } from "./filter"

export type WSData = {
  id: string
  challenge: string
  authedPubkeys: Set<string>
}

const MAX_SUBS_PER_CONNECTION = 20

type SubscriptionEntry = {
  filters: Filter[]
}

// Per-connection subscription state
const connectionSubs = new Map<string, Map<string, SubscriptionEntry>>()

function send(ws: ServerWebSocket<WSData>, msg: RelayMessage) {
  ws.send(JSON.stringify(msg))
}

export function addSubscription(
  ws: ServerWebSocket<WSData>,
  subId: string,
  filters: Filter[],
  storage: Storage
) {
  const connId = ws.data.id

  if (!connectionSubs.has(connId)) {
    connectionSubs.set(connId, new Map())
  }
  const subs = connectionSubs.get(connId)!

  // Check sub limit (replacing existing sub with same id is allowed)
  if (!subs.has(subId) && subs.size >= MAX_SUBS_PER_CONNECTION) {
    send(ws, ["CLOSED", subId, "error: too many subscriptions"])
    return
  }

  // Store the subscription
  subs.set(subId, { filters })

  // Query historical events
  const events = storage.queryEvents(filters)
  for (const event of events) {
    send(ws, ["EVENT", subId, event])
  }

  // Signal end of stored events
  send(ws, ["EOSE", subId])
}

export function removeSubscription(ws: ServerWebSocket<WSData>, subId: string) {
  const connId = ws.data.id
  const subs = connectionSubs.get(connId)
  if (subs) {
    subs.delete(subId)
    if (subs.size === 0) {
      connectionSubs.delete(connId)
    }
  }
}

export function removeAllSubscriptions(ws: ServerWebSocket<WSData>) {
  connectionSubs.delete(ws.data.id)
}

export function broadcastEvent(
  event: NostrEvent,
  server: { publish(topic: string, data: string): void },
  allConnections: Map<string, ServerWebSocket<WSData>>
) {
  // Iterate all connections and their subscriptions
  for (const [connId, subs] of connectionSubs) {
    const ws = allConnections.get(connId)
    if (!ws) {
      connectionSubs.delete(connId)
      continue
    }
    for (const [subId, entry] of subs) {
      if (matchFilters(event, entry.filters)) {
        send(ws, ["EVENT", subId, event])
      }
    }
  }
}
