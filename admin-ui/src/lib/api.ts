const BASE = "/admin/api"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (res.status === 401) {
    window.location.href = "/admin/login"
    throw new Error("Unauthorized")
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  return res.json()
}

// Auth
export function login(token: string) {
  return request<{ ok: boolean }>("/login", {
    method: "POST",
    body: JSON.stringify({ token }),
  })
}

export function logout() {
  return request<{ ok: boolean }>("/logout", { method: "POST" })
}

// Stats
export type Stats = {
  connections: number
  events: number
  blobs: number
  blobStorage: number
}

export function fetchStats() {
  return request<Stats>("/stats")
}

// Allowlist
export type AllowedPubkey = {
  pubkey: string
  expires_at: number | null
}

export function fetchAllowlist() {
  return request<{ pubkeys: AllowedPubkey[] }>("/allow")
}

export function addPubkey(pubkey: string, expires_at?: number | null) {
  return request<{ allowed: boolean }>("/allow", {
    method: "POST",
    body: JSON.stringify({ pubkey, expires_at: expires_at ?? null }),
  })
}

export function revokePubkey(pubkey: string) {
  return request<{ revoked: boolean }>(`/allow/${pubkey}`, {
    method: "DELETE",
  })
}

// Blobs
export type BlobEntry = {
  sha256: string
  size: number
  type: string | null
  uploaded_at: string
}

export function fetchBlobs() {
  return request<{ blobs: BlobEntry[] }>("/blobs")
}

export function deleteBlob(sha256: string) {
  return request<{ deleted: boolean }>(`/blobs/${sha256}`, {
    method: "DELETE",
  })
}

// Events
export type EventEntry = {
  id: string
  pubkey: string
  kind: number
  created_at: number
  content: string
}

export function fetchEvents(params?: { kind?: number; pubkey?: string }) {
  const search = new URLSearchParams()
  if (params?.kind !== undefined) search.set("kind", String(params.kind))
  if (params?.pubkey) search.set("pubkey", params.pubkey)
  const qs = search.toString()
  return request<{ events: EventEntry[] }>(`/events${qs ? `?${qs}` : ""}`)
}

// Connections
export type ConnectionEntry = {
  id: string
  authedPubkeys: string[]
}

export function fetchConnections() {
  return request<{ connections: ConnectionEntry[] }>("/connections")
}
