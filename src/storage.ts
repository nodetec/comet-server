import { Database } from "bun:sqlite"
import type { NostrEvent, Filter, ChangeEntry, ChangesFilter } from "./types"
import { getEventKindCategory } from "./event"
import { isDeletionEvent, getDeletionTargetIds, getDeletionTargetAddrs, KIND_DELETION } from "./nip-09"
import { KIND_GIFT_WRAP, canDeleteGiftWrap, isGiftWrap } from "./nip-59"

export interface Storage {
  db: Database
  saveEvent(event: NostrEvent): { saved: boolean; reason?: string; changes: ChangeEntry[] }
  queryEvents(filters: Filter[]): NostrEvent[]
  deleteEvent(id: string): boolean
  processDeletionRequest(event: NostrEvent): { deleted: number; changes: ChangeEntry[] }
  isEventDeleted(id: string): boolean
  queryChanges(filter: ChangesFilter): ChangeEntry[]
  getMaxSeq(): number
  getMinSeq(): number
  close(): void
}

export function initStorage(dbPath: string): Storage {
  // Ensure parent directory exists
  const dir = dbPath.substring(0, dbPath.lastIndexOf("/"))
  if (dir) {
    const fs = require("fs")
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(dbPath)

  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA foreign_keys = ON")

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      pubkey      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      kind        INTEGER NOT NULL,
      tags        TEXT NOT NULL,
      content     TEXT NOT NULL,
      sig         TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_tags (
      event_id   TEXT NOT NULL,
      tag_name   TEXT NOT NULL,
      tag_value  TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `)

  // Track deleted event IDs to prevent re-insertion (NIP-09)
  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_events (
      event_id       TEXT NOT NULL,
      deletion_id    TEXT NOT NULL,
      pubkey         TEXT NOT NULL,
      PRIMARY KEY (event_id)
    )
  `)

  // Track deleted addressable coordinates to prevent re-insertion
  db.exec(`
    CREATE TABLE IF NOT EXISTS deleted_coords (
      kind           INTEGER NOT NULL,
      pubkey         TEXT NOT NULL,
      d_tag          TEXT NOT NULL,
      deleted_up_to  INTEGER NOT NULL,
      deletion_id    TEXT NOT NULL,
      PRIMARY KEY (kind, pubkey, d_tag)
    )
  `)

  // NIP-CF: Changes feed changelog
  db.exec(`
    CREATE TABLE IF NOT EXISTS changes (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id   TEXT NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('STORED', 'DELETED')),
      kind       INTEGER NOT NULL,
      pubkey     TEXT NOT NULL,
      reason     TEXT,
      tags       TEXT              -- JSON: denormalized single-letter tags for filtering deleted entries
    )
  `)

  db.exec("CREATE INDEX IF NOT EXISTS idx_changes_kind ON changes(kind)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_changes_pubkey ON changes(pubkey)")

  // Tag index for changelog entries (enables tag-filtered CHANGES queries on deleted events)
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_tags (
      seq        INTEGER NOT NULL,
      tag_name   TEXT NOT NULL,
      tag_value  TEXT NOT NULL,
      FOREIGN KEY (seq) REFERENCES changes(seq) ON DELETE CASCADE
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_change_tags_lookup ON change_tags(tag_name, tag_value)")

  db.exec("CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events(pubkey, kind)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_tags_lookup ON event_tags(tag_name, tag_value)")

  // Prepared statements
  const insertEvent = db.prepare(
    "INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  const insertTag = db.prepare(
    "INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)"
  )
  const deleteById = db.prepare("DELETE FROM events WHERE id = ?")
  const selectById = db.prepare("SELECT * FROM events WHERE id = ?")
  const deleteReplaceable = db.prepare(
    "DELETE FROM events WHERE pubkey = ? AND kind = ? AND created_at < ?"
  )
  const selectReplaceable = db.prepare(
    "SELECT created_at FROM events WHERE pubkey = ? AND kind = ? ORDER BY created_at DESC LIMIT 1"
  )
  const deleteAddressable = db.prepare(
    "DELETE FROM events WHERE pubkey = ? AND kind = ? AND id IN (SELECT e.id FROM events e JOIN event_tags t ON e.id = t.event_id WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ? AND e.created_at < ?)"
  )
  const selectAddressable = db.prepare(
    "SELECT e.created_at FROM events e JOIN event_tags t ON e.id = t.event_id WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ? ORDER BY e.created_at DESC LIMIT 1"
  )

  // Replaceable gift wrap prepared statements (kind:1059 with p-tag + d-tag)
  const selectGiftWrapByPD = db.prepare(
    "SELECT e.id, e.created_at, e.kind, e.pubkey, e.tags FROM events e " +
    "JOIN event_tags tp ON e.id = tp.event_id AND tp.tag_name = 'p' AND tp.tag_value = ? " +
    "JOIN event_tags td ON e.id = td.event_id AND td.tag_name = 'd' AND td.tag_value = ? " +
    "WHERE e.kind = 1059 ORDER BY e.created_at DESC LIMIT 1"
  )
  const deleteGiftWrapByPD = db.prepare(
    "DELETE FROM events WHERE kind = 1059 AND id IN (" +
    "SELECT e.id FROM events e " +
    "JOIN event_tags tp ON e.id = tp.event_id AND tp.tag_name = 'p' AND tp.tag_value = ? " +
    "JOIN event_tags td ON e.id = td.event_id AND td.tag_name = 'd' AND td.tag_value = ? " +
    "WHERE e.kind = 1059 AND e.created_at < ?)"
  )
  const selectGiftWrapIdsByPD = db.prepare(
    "SELECT e.id, e.kind, e.pubkey, e.tags FROM events e " +
    "JOIN event_tags tp ON e.id = tp.event_id AND tp.tag_name = 'p' AND tp.tag_value = ? " +
    "JOIN event_tags td ON e.id = td.event_id AND td.tag_name = 'd' AND td.tag_value = ? " +
    "WHERE e.kind = 1059 AND e.created_at < ?"
  )

  // NIP-09 deletion prepared statements
  const insertDeletedEvent = db.prepare(
    "INSERT OR IGNORE INTO deleted_events (event_id, deletion_id, pubkey) VALUES (?, ?, ?)"
  )
  const selectDeletedEvent = db.prepare(
    "SELECT 1 FROM deleted_events WHERE event_id = ?"
  )
  const selectEventPubkey = db.prepare(
    "SELECT pubkey FROM events WHERE id = ?"
  )
  const insertDeletedCoord = db.prepare(
    "INSERT INTO deleted_coords (kind, pubkey, d_tag, deleted_up_to, deletion_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, pubkey, d_tag) DO UPDATE SET deleted_up_to = MAX(deleted_up_to, excluded.deleted_up_to), deletion_id = excluded.deletion_id"
  )
  const selectDeletedCoord = db.prepare(
    "SELECT deleted_up_to FROM deleted_coords WHERE kind = ? AND pubkey = ? AND d_tag = ?"
  )
  const deleteAddressableByCoord = db.prepare(
    "DELETE FROM events WHERE pubkey = ? AND kind = ? AND id IN (SELECT e.id FROM events e JOIN event_tags t ON e.id = t.event_id WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ? AND e.created_at <= ?)"
  )

  // NIP-CF: changelog prepared statements
  const insertChange = db.prepare(
    "INSERT INTO changes (event_id, type, kind, pubkey, reason, tags) VALUES (?, ?, ?, ?, ?, ?)"
  )
  const insertChangeTag = db.prepare(
    "INSERT INTO change_tags (seq, tag_name, tag_value) VALUES (?, ?, ?)"
  )
  const selectLastRowId = db.prepare("SELECT last_insert_rowid() as seq")
  const selectMaxSeq = db.prepare("SELECT MAX(seq) as max_seq FROM changes")
  const selectMinSeq = db.prepare("SELECT MIN(seq) as min_seq FROM changes")

  // Queries to find event IDs + tags before deletion (for changelog)
  const selectReplaceableIds = db.prepare(
    "SELECT id, kind, pubkey, tags FROM events WHERE pubkey = ? AND kind = ? AND created_at < ?"
  )
  const selectAddressableIds = db.prepare(
    "SELECT e.id, e.kind, e.pubkey, e.tags FROM events e JOIN event_tags t ON e.id = t.event_id WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ? AND e.created_at < ?"
  )
  const selectAddressableIdsByCoord = db.prepare(
    "SELECT e.id, e.kind, e.pubkey, e.tags FROM events e JOIN event_tags t ON e.id = t.event_id WHERE e.pubkey = ? AND e.kind = ? AND t.tag_name = 'd' AND t.tag_value = ? AND e.created_at <= ?"
  )

  type SingleLetterTag = [string, string]

  /** Extract single-letter tags from an event's tags (for changelog denormalization). */
  function extractSingleLetterTags(tags: string[][]): SingleLetterTag[] {
    return tags
      .filter((t) => t.length >= 2 && t[0].length === 1)
      .map((t) => [t[0], t[1]])
  }

  function recordChange(
    eventId: string,
    type: "STORED" | "DELETED",
    kind: number,
    pubkey: string,
    reason: object | null,
    tags: SingleLetterTag[]
  ): ChangeEntry {
    const reasonJson = reason ? JSON.stringify(reason) : null
    const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null
    insertChange.run(eventId, type, kind, pubkey, reasonJson, tagsJson)
    const seq = (selectLastRowId.get() as { seq: number }).seq
    for (const [name, value] of tags) {
      insertChangeTag.run(seq, name, value)
    }
    return { seq, eventId, type, kind, pubkey, reason: reason as ChangeEntry["reason"], tags }
  }

  function insertEventWithTags(event: NostrEvent) {
    insertEvent.run(
      event.id,
      event.pubkey,
      event.created_at,
      event.kind,
      JSON.stringify(event.tags),
      event.content,
      event.sig
    )
    for (const tag of event.tags) {
      if (tag.length >= 2 && tag[0].length === 1) {
        insertTag.run(event.id, tag[0], tag[1])
      }
    }
  }

  function saveEvent(event: NostrEvent): { saved: boolean; reason?: string; changes: ChangeEntry[] } {
    const category = getEventKindCategory(event.kind)

    if (category === "ephemeral") {
      return { saved: false, reason: "ephemeral events are not stored", changes: [] }
    }

    // NIP-09: reject events that have been deleted
    if (isEventDeleted(event.id)) {
      return { saved: false, reason: "deleted: this event has been deleted", changes: [] }
    }

    // Replaceable gift wraps: kind:1059 with both p-tag and d-tag
    // Replaced by p-tag + d-tag (not pubkey, since gift wraps use ephemeral keys)
    if (isGiftWrap(event)) {
      const pTag = event.tags.find(([t]) => t === "p")?.[1]
      const dTag = event.tags.find(([t]) => t === "d")?.[1]

      if (pTag && dTag) {
        const existing = selectGiftWrapByPD.get(pTag, dTag) as
          | { id: string; created_at: number }
          | undefined
        if (existing && existing.created_at >= event.created_at) {
          return { saved: false, reason: "duplicate: a newer replaceable gift wrap exists", changes: [] }
        }
        const changes: ChangeEntry[] = []
        const doReplace = db.transaction(() => {
          const oldEvents = selectGiftWrapIdsByPD.all(pTag, dTag, event.created_at) as
            Array<{ id: string; kind: number; pubkey: string; tags: string }>
          deleteGiftWrapByPD.run(pTag, dTag, event.created_at)
          insertEventWithTags(event)
          for (const old of oldEvents) {
            const oldTags = extractSingleLetterTags(JSON.parse(old.tags))
            changes.push(recordChange(old.id, "DELETED", old.kind, old.pubkey, { superseded_by: event.id }, oldTags))
          }
          changes.push(recordChange(event.id, "STORED", event.kind, event.pubkey, null, extractSingleLetterTags(event.tags)))
        })
        doReplace()
        return { saved: true, changes }
      }
    }

    // NIP-09: for addressable events, check if the coordinate has been deleted
    if (category === "addressable") {
      const dTag = event.tags.find(([t]) => t === "d")?.[1] ?? ""
      const deletedCoord = selectDeletedCoord.get(event.kind, event.pubkey, dTag) as
        | { deleted_up_to: number }
        | undefined
      if (deletedCoord && event.created_at <= deletedCoord.deleted_up_to) {
        return { saved: false, reason: "deleted: this addressable event has been deleted", changes: [] }
      }
    }

    if (category === "replaceable") {
      const existing = selectReplaceable.get(event.pubkey, event.kind) as
        | { created_at: number }
        | undefined
      if (existing && existing.created_at >= event.created_at) {
        return { saved: false, reason: "duplicate: a newer replaceable event exists", changes: [] }
      }
      const changes: ChangeEntry[] = []
      const doReplace = db.transaction(() => {
        // Find old events before deleting (need tags for changelog)
        const oldEvents = selectReplaceableIds.all(event.pubkey, event.kind, event.created_at) as
          Array<{ id: string; kind: number; pubkey: string; tags: string }>
        deleteReplaceable.run(event.pubkey, event.kind, event.created_at)
        insertEventWithTags(event)
        for (const old of oldEvents) {
          const oldTags = extractSingleLetterTags(JSON.parse(old.tags))
          changes.push(recordChange(old.id, "DELETED", old.kind, old.pubkey, { superseded_by: event.id }, oldTags))
        }
        changes.push(recordChange(event.id, "STORED", event.kind, event.pubkey, null, extractSingleLetterTags(event.tags)))
      })
      doReplace()
      return { saved: true, changes }
    }

    if (category === "addressable") {
      const dTag = event.tags.find(([t]) => t === "d")?.[1] ?? ""
      const existing = selectAddressable.get(event.pubkey, event.kind, dTag) as
        | { created_at: number }
        | undefined
      if (existing && existing.created_at >= event.created_at) {
        return { saved: false, reason: "duplicate: a newer addressable event exists", changes: [] }
      }
      const changes: ChangeEntry[] = []
      const doReplace = db.transaction(() => {
        const oldEvents = selectAddressableIds.all(event.pubkey, event.kind, dTag, event.created_at) as
          Array<{ id: string; kind: number; pubkey: string; tags: string }>
        deleteAddressable.run(event.pubkey, event.kind, event.pubkey, event.kind, dTag, event.created_at)
        insertEventWithTags(event)
        for (const old of oldEvents) {
          const oldTags = extractSingleLetterTags(JSON.parse(old.tags))
          changes.push(recordChange(old.id, "DELETED", old.kind, old.pubkey, { superseded_by: event.id }, oldTags))
        }
        changes.push(recordChange(event.id, "STORED", event.kind, event.pubkey, null, extractSingleLetterTags(event.tags)))
      })
      doReplace()
      return { saved: true, changes }
    }

    // Regular event
    const existing = selectById.get(event.id)
    if (existing) {
      return { saved: false, reason: "duplicate: event already exists", changes: [] }
    }

    const changes: ChangeEntry[] = []
    const doInsert = db.transaction(() => {
      insertEventWithTags(event)
      changes.push(recordChange(event.id, "STORED", event.kind, event.pubkey, null, extractSingleLetterTags(event.tags)))
    })
    doInsert()
    return { saved: true, changes }
  }

  function queryEvents(filters: Filter[]): NostrEvent[] {
    if (filters.length === 0) return []

    const results = new Map<string, NostrEvent>()

    for (const filter of filters) {
      const conditions: string[] = []
      const params: (string | number)[] = []
      let needsTagJoin = false

      if (filter.ids && filter.ids.length > 0) {
        conditions.push(`e.id IN (${filter.ids.map(() => "?").join(",")})`)
        params.push(...filter.ids)
      }
      if (filter.authors && filter.authors.length > 0) {
        conditions.push(`e.pubkey IN (${filter.authors.map(() => "?").join(",")})`)
        params.push(...filter.authors)
      }
      if (filter.kinds && filter.kinds.length > 0) {
        conditions.push(`e.kind IN (${filter.kinds.map(() => "?").join(",")})`)
        params.push(...filter.kinds)
      }
      if (filter.since != null) {
        conditions.push("e.created_at >= ?")
        params.push(filter.since)
      }
      if (filter.until != null) {
        conditions.push("e.created_at <= ?")
        params.push(filter.until)
      }

      // Tag filters
      let tagJoinIndex = 0
      for (const key of Object.keys(filter)) {
        if (key[0] === "#") {
          const tagName = key.slice(1)
          const values = filter[key as `#${string}`]
          if (!Array.isArray(values) || values.length === 0) continue
          needsTagJoin = true
          const alias = `t${tagJoinIndex++}`
          conditions.push(
            `EXISTS (SELECT 1 FROM event_tags ${alias} WHERE ${alias}.event_id = e.id AND ${alias}.tag_name = ? AND ${alias}.tag_value IN (${values.map(() => "?").join(",")}))`
          )
          params.push(tagName, ...values)
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
      const limit = filter.limit != null ? `LIMIT ${Math.max(0, filter.limit)}` : ""

      const sql = `SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig FROM events e ${where} ORDER BY e.created_at DESC ${limit}`

      const stmt = db.prepare(sql)
      const rows = stmt.all(...params) as Array<{
        id: string
        pubkey: string
        created_at: number
        kind: number
        tags: string
        content: string
        sig: string
      }>

      for (const row of rows) {
        if (!results.has(row.id)) {
          results.set(row.id, {
            id: row.id,
            pubkey: row.pubkey,
            created_at: row.created_at,
            kind: row.kind,
            tags: JSON.parse(row.tags),
            content: row.content,
            sig: row.sig,
          })
        }
      }
    }

    // Sort by created_at DESC, then id ASC for ties
    return Array.from(results.values()).sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at
      return a.id.localeCompare(b.id)
    })
  }

  function deleteEvent(id: string): boolean {
    const result = deleteById.run(id)
    return result.changes > 0
  }

  /** NIP-09: Process a kind:5 deletion request. Deletes referenced events owned by the same pubkey. */
  function processDeletionRequest(event: NostrEvent): { deleted: number; changes: ChangeEntry[] } {
    if (!isDeletionEvent(event)) return { deleted: 0, changes: [] }

    let deleted = 0
    const changes: ChangeEntry[] = []

    const processDelete = db.transaction(() => {
      // Handle `e` tag targets (specific event IDs)
      const targetIds = getDeletionTargetIds(event)
      for (const targetId of targetIds) {
        const targetEvent = selectById.get(targetId) as
          | { pubkey: string; kind: number; tags: string }
          | undefined

        // Determine if deletion is authorized:
        // - Normal events: target pubkey must match deletion author
        // - Gift wraps (kind:1059): deletion author must be in target's p-tags
        //   (gift wraps use random ephemeral signing keys)
        let authorized = false
        if (targetEvent) {
          if (targetEvent.kind === KIND_GIFT_WRAP) {
            const parsedTags = JSON.parse(targetEvent.tags) as string[][]
            authorized = canDeleteGiftWrap(
              { ...targetEvent, tags: parsedTags } as any,
              event.pubkey
            )
          } else {
            authorized = targetEvent.pubkey === event.pubkey
          }
        }

        if (targetEvent && authorized) {
          const targetTags = extractSingleLetterTags(JSON.parse(targetEvent.tags))
          const result = deleteById.run(targetId)
          if (result.changes > 0) {
            deleted += result.changes
            changes.push(recordChange(targetId, "DELETED", targetEvent.kind, event.pubkey, { deletion_id: event.id }, targetTags))
          }
        }
        // Record deletion regardless (prevents re-insertion even if event wasn't stored)
        insertDeletedEvent.run(targetId, event.id, event.pubkey)
      }

      // Handle `a` tag targets (addressable event coordinates)
      const addrTargets = getDeletionTargetAddrs(event)
      for (const addr of addrTargets) {
        // Only process if the addr pubkey matches the deletion author
        if (addr.pubkey !== event.pubkey) continue

        // Find event IDs + tags before deleting (for changelog)
        const affected = selectAddressableIdsByCoord.all(
          addr.pubkey, addr.kind, addr.dTag, event.created_at
        ) as Array<{ id: string; kind: number; pubkey: string; tags: string }>

        // Delete all versions up to the deletion request's created_at
        const result = deleteAddressableByCoord.run(
          addr.pubkey,
          addr.kind,
          addr.pubkey,
          addr.kind,
          addr.dTag,
          event.created_at
        )
        deleted += result.changes

        // Record changelog entries
        for (const a of affected) {
          const aTags = extractSingleLetterTags(JSON.parse(a.tags))
          changes.push(recordChange(a.id, "DELETED", a.kind, a.pubkey, { deletion_id: event.id }, aTags))
        }

        // Record the coordinate deletion to prevent re-insertion
        insertDeletedCoord.run(addr.kind, addr.pubkey, addr.dTag, event.created_at, event.id)
      }
    })

    processDelete()
    return { deleted, changes }
  }

  function isEventDeleted(id: string): boolean {
    return selectDeletedEvent.get(id) != null
  }

  /** NIP-CF: Query the changelog with filters. */
  function queryChanges(filter: ChangesFilter): ChangeEntry[] {
    const conditions: string[] = []
    const params: (string | number)[] = []

    const since = filter.since ?? 0
    conditions.push("c.seq > ?")
    params.push(since)

    if (filter.until_seq != null) {
      conditions.push("c.seq <= ?")
      params.push(filter.until_seq)
    }
    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(`c.kind IN (${filter.kinds.map(() => "?").join(",")})`)
      params.push(...filter.kinds)
    }
    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`c.pubkey IN (${filter.authors.map(() => "?").join(",")})`)
      params.push(...filter.authors)
    }

    // Tag filters — use change_tags which has denormalized tags for both STORED and DELETED entries
    for (const key of Object.keys(filter)) {
      if (key[0] === "#") {
        const tagName = key.slice(1)
        const values = filter[key as `#${string}`]
        if (!Array.isArray(values) || values.length === 0) continue
        conditions.push(
          `EXISTS (SELECT 1 FROM change_tags ct WHERE ct.seq = c.seq AND ct.tag_name = ? AND ct.tag_value IN (${values.map(() => "?").join(",")}))`
        )
        params.push(tagName, ...values)
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const limit = filter.limit != null ? `LIMIT ${Math.max(0, filter.limit)}` : ""

    const sql = `SELECT c.seq, c.event_id, c.type, c.kind, c.pubkey, c.reason FROM changes c ${where} ORDER BY c.seq ASC ${limit}`
    const rows = db.prepare(sql).all(...params) as Array<{
      seq: number
      event_id: string
      type: "STORED" | "DELETED"
      kind: number
      pubkey: string
      reason: string | null
    }>

    return rows.map((row) => ({
      seq: row.seq,
      eventId: row.event_id,
      type: row.type,
      kind: row.kind,
      pubkey: row.pubkey,
      reason: row.reason ? JSON.parse(row.reason) : null,
    }))
  }

  function getMaxSeq(): number {
    const row = selectMaxSeq.get() as { max_seq: number | null }
    return row.max_seq ?? 0
  }

  function getMinSeq(): number {
    const row = selectMinSeq.get() as { min_seq: number | null }
    return row.min_seq ?? 0
  }

  function close() {
    db.close()
  }

  return { db, saveEvent, queryEvents, deleteEvent, processDeletionRequest, isEventDeleted, queryChanges, getMaxSeq, getMinSeq, close }
}
