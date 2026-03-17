import { validateAndVerifyEvent } from "../relay/event"
import type { NostrEvent } from "../types"

const KIND_BLOSSOM_AUTH = 24242

type BlossomAuthResult = {
  ok: boolean
  pubkey?: string
  reason?: string
}

/**
 * Parse and validate a Blossom authorization header.
 * Expects: `Authorization: Nostr <base64url-encoded kind:24242 event>`
 */
export function validateBlossomAuth(
  authHeader: string | undefined,
  expectedAction: string,
  opts?: { sha256?: string }
): BlossomAuthResult {
  if (!authHeader || !authHeader.startsWith("Nostr ")) {
    return { ok: false, reason: "missing or invalid Authorization header" }
  }

  const base64 = authHeader.slice(6)
  let eventJson: string
  try {
    eventJson = atob(base64)
  } catch {
    return { ok: false, reason: "invalid base64 in Authorization header" }
  }

  let event: unknown
  try {
    event = JSON.parse(eventJson)
  } catch {
    return { ok: false, reason: "invalid JSON in Authorization header" }
  }

  const validation = validateAndVerifyEvent(event)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }

  const e = event as NostrEvent

  if (e.kind !== KIND_BLOSSOM_AUTH) {
    return { ok: false, reason: `invalid kind: expected ${KIND_BLOSSOM_AUTH}` }
  }

  // Check expiration tag
  const expirationTag = e.tags.find(([t]) => t === "expiration")
  if (expirationTag && expirationTag[1]) {
    const exp = parseInt(expirationTag[1], 10)
    const now = Math.floor(Date.now() / 1000)
    if (exp < now) {
      return { ok: false, reason: "authorization expired" }
    }
  }

  // Check `t` tag matches expected action
  const tTag = e.tags.find(([t]) => t === "t")
  if (!tTag || tTag[1] !== expectedAction) {
    return { ok: false, reason: `invalid action: expected "${expectedAction}"` }
  }

  // Check `x` tag if sha256 is expected
  if (opts?.sha256) {
    const xTag = e.tags.find(([t]) => t === "x")
    if (!xTag || xTag[1] !== opts.sha256) {
      return { ok: false, reason: "sha256 mismatch in x tag" }
    }
  }

  return { ok: true, pubkey: e.pubkey }
}
