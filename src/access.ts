import { eq } from "drizzle-orm"
import type { DB } from "./db"
import { allowedPubkeys } from "./schema"

export interface AccessControl {
  isAllowed(pubkey: string): boolean
  allow(pubkey: string, expiresAt: number | null): Promise<void>
  revoke(pubkey: string): Promise<boolean>
  list(): Promise<Array<{ pubkey: string; expires_at: number | null }>>
  readonly privateMode: boolean
}

export async function initAccessControl(db: DB, privateMode: boolean): Promise<AccessControl> {
  // Pre-load allowlist into memory for fast sync checks
  const allowedSet = new Map<string, number | null>()
  if (privateMode) {
    const rows = await db.select({ pubkey: allowedPubkeys.pubkey, expiresAt: allowedPubkeys.expiresAt }).from(allowedPubkeys)
    for (const row of rows) {
      allowedSet.set(row.pubkey, row.expiresAt)
    }
  }

  function isAllowed(pubkey: string): boolean {
    if (!privateMode) return true
    const expiresAt = allowedSet.get(pubkey)
    if (expiresAt === undefined) return false
    if (expiresAt === null) return true
    return expiresAt > Math.floor(Date.now() / 1000)
  }

  async function allow(pubkey: string, expiresAt: number | null): Promise<void> {
    await db.insert(allowedPubkeys).values({ pubkey, expiresAt })
      .onConflictDoUpdate({ target: allowedPubkeys.pubkey, set: { expiresAt } })
    allowedSet.set(pubkey, expiresAt)
  }

  async function revoke(pubkey: string): Promise<boolean> {
    const result = await db.delete(allowedPubkeys).where(eq(allowedPubkeys.pubkey, pubkey))
    allowedSet.delete(pubkey)
    return (result as any).count > 0
  }

  async function list(): Promise<Array<{ pubkey: string; expires_at: number | null }>> {
    const rows = await db
      .select({ pubkey: allowedPubkeys.pubkey, expiresAt: allowedPubkeys.expiresAt })
      .from(allowedPubkeys)
      .orderBy(allowedPubkeys.createdAt)
    return rows.map((r) => ({ pubkey: r.pubkey, expires_at: r.expiresAt }))
  }

  return { isAllowed, allow, revoke, list, privateMode }
}
