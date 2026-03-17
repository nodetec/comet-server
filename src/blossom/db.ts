import { eq, desc, count, sum, sql } from "drizzle-orm"
import type { DB } from "../db"
import { blobs, blobOwners } from "../schema"

export type BlobRecord = {
  sha256: string
  size: number
  type: string | null
  uploaded_at: string
}

export async function insertBlob(db: DB, sha256: string, size: number, type: string | null, pubkey: string): Promise<void> {
  await db.insert(blobs).values({ sha256, size, type }).onConflictDoNothing()
  await db.insert(blobOwners).values({ sha256, pubkey }).onConflictDoNothing()
}

export async function getBlob(db: DB, sha256: string): Promise<BlobRecord | null> {
  const [row] = await db
    .select({ sha256: blobs.sha256, size: blobs.size, type: blobs.type, uploadedAt: blobs.uploadedAt })
    .from(blobs)
    .where(eq(blobs.sha256, sha256))
  if (!row) return null
  return { sha256: row.sha256, size: row.size, type: row.type, uploaded_at: row.uploadedAt.toISOString() }
}

export async function listBlobsByPubkey(db: DB, pubkey: string): Promise<BlobRecord[]> {
  const rows = await db
    .select({ sha256: blobs.sha256, size: blobs.size, type: blobs.type, uploadedAt: blobs.uploadedAt })
    .from(blobs)
    .innerJoin(blobOwners, eq(blobs.sha256, blobOwners.sha256))
    .where(eq(blobOwners.pubkey, pubkey))
    .orderBy(desc(blobs.uploadedAt))
  return rows.map((r) => ({ sha256: r.sha256, size: r.size, type: r.type, uploaded_at: r.uploadedAt.toISOString() }))
}

export async function removeOwner(db: DB, sha256: string, pubkey: string): Promise<boolean> {
  const result = await db.delete(blobOwners).where(
    sql`${blobOwners.sha256} = ${sha256} AND ${blobOwners.pubkey} = ${pubkey}`
  )
  if ((result as any).count === 0) return false

  const [remaining] = await db
    .select({ sha256: blobOwners.sha256 })
    .from(blobOwners)
    .where(eq(blobOwners.sha256, sha256))
    .limit(1)
  return remaining == null
}

export async function deleteBlob(db: DB, sha256: string): Promise<void> {
  await db.delete(blobs).where(eq(blobs.sha256, sha256))
}

export async function getBlobCount(db: DB): Promise<number> {
  const [row] = await db.select({ val: count() }).from(blobs)
  return Number(row.val)
}

export async function getBlobTotalSize(db: DB): Promise<number> {
  const [row] = await db.select({ val: sql<number>`COALESCE(SUM(${blobs.size}), 0)` }).from(blobs)
  return Number(row.val)
}
