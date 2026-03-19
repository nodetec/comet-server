import { useState, useEffect, useRef, useCallback } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileText, Loader2, Inbox } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useNostr } from "@/hooks/use-nostr"
import { useNotes } from "@/hooks/use-notes"
import { decryptBlob } from "@/lib/blob-crypto"
import type { BlobRef, Note } from "@/lib/rumor"

// ── Blob image cache & component ────────────────────────────────────────

const blobUrlCache = new Map<string, string>()

function BlobImage({
  blobRef,
  alt,
  className,
}: {
  blobRef: BlobRef
  alt?: string
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(
    () => blobUrlCache.get(blobRef.ciphertextHash) ?? null
  )
  const [error, setError] = useState(false)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (url || fetchedRef.current) return
    fetchedRef.current = true

    async function load() {
      try {
        const cached = blobUrlCache.get(blobRef.ciphertextHash)
        if (cached) {
          setUrl(cached)
          return
        }

        const response = await fetch(`/${blobRef.ciphertextHash}`)
        if (!response.ok) throw new Error("fetch failed")
        const data = new Uint8Array(await response.arrayBuffer())
        const decrypted = decryptBlob(data, blobRef.encryptionKey)
        const blob = new Blob([decrypted as BlobPart])
        const objectUrl = URL.createObjectURL(blob)
        blobUrlCache.set(blobRef.ciphertextHash, objectUrl)
        setUrl(objectUrl)
      } catch {
        setError(true)
      }
    }

    void load()
  }, [blobRef, url])

  if (error) {
    return (
      <div className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
        Failed to load image
      </div>
    )
  }

  if (!url) {
    return <Skeleton className="h-48 w-full rounded-md" />
  }

  return (
    <img
      src={url}
      alt={alt ?? ""}
      className={cn("max-w-full rounded-md", className)}
    />
  )
}

// ── Markdown renderer with attachment support ───────────────────────────

function NoteMarkdown({ note }: { note: Note }) {
  const blobMap = useRef<Map<string, BlobRef>>(new Map())

  useEffect(() => {
    blobMap.current.clear()
    for (const blob of note.blobs) {
      blobMap.current.set(blob.plaintextHash, blob)
    }
  }, [note.blobs])

  const imgComponent = useCallback(
    (props: React.ComponentProps<"img">) => {
      const src = props.src ?? ""

      if (src.startsWith("attachment://")) {
        const plaintextHash = src.replace("attachment://", "").replace(/\.\w+$/, "")
        const blobRef = blobMap.current.get(plaintextHash)
        if (blobRef) {
          return <BlobImage blobRef={blobRef} alt={props.alt ?? undefined} />
        }
        return (
          <span className="text-xs text-muted-foreground">
            [missing attachment]
          </span>
        )
      }

      return (
        <img
          src={src}
          alt={props.alt ?? ""}
          className="max-w-full rounded-md"
        />
      )
    },
    []
  )

  // Strip the title from markdown since we render it in the header
  const content =
    note.title && note.markdown.startsWith(`# ${note.title}\n\n`)
      ? note.markdown.slice(`# ${note.title}\n\n`.length)
      : note.markdown

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:tracking-tight prose-p:leading-relaxed prose-a:text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ img: imgComponent }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatRelativeDate(millis: number): string {
  const now = Date.now()
  const diff = now - millis
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 30) {
    return new Date(millis).toLocaleDateString()
  }
  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return "just now"
}

function formatFullDate(millis: number): string {
  return new Date(millis).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

function getSnippet(markdown: string, maxLen = 120): string {
  const lines = markdown.split("\n")
  const contentLines = lines.filter((l) => !l.startsWith("# ") && l.trim())
  const text = contentLines.join(" ").slice(0, maxLen)
  return text.length >= maxLen ? text + "..." : text
}

// ── Note list item ──────────────────────────────────────────────────────

function NoteListItem({
  note,
  isSelected,
  onSelect,
}: {
  note: Note
  isSelected: boolean
  onSelect: () => void
}) {
  const hasTitle = !!note.title
  return (
    <button
      onClick={onSelect}
      className={cn(
        "relative flex h-[6.75rem] w-full cursor-default flex-col items-start gap-1.5 overflow-hidden rounded-md px-3 py-2.5 text-left text-sm transition-colors",
        isSelected
          ? "bg-accent/50"
          : "hover:bg-accent/30"
      )}
    >
      <h3 className={cn(
        "min-w-0 w-full truncate font-semibold",
        hasTitle ? "text-foreground" : "text-muted-foreground"
      )}>
        {note.title || "Untitled"}
      </h3>
      <p className={cn(
        "text-sm text-muted-foreground w-full break-all whitespace-break-spaces",
        hasTitle ? "line-clamp-2" : "line-clamp-3"
      )}>
        {getSnippet(note.markdown, 160)}
      </p>
      <div className="mt-auto flex w-full items-center gap-2 min-w-0">
        <span className="text-xs text-muted-foreground/70 min-w-0 truncate">
          {formatRelativeDate(note.modifiedAt)}
        </span>
        {note.tags.length > 0 && (
          <span className="ml-auto text-xs text-primary min-w-0 truncate">
            {note.tags.slice(0, 2).map((t) => `#${t}`).join(" ")}
          </span>
        )}
      </div>
    </button>
  )
}

function NoteListSeparator({ hidden }: { hidden?: boolean }) {
  return (
    <div className={cn("h-px w-full", hidden ? "bg-transparent" : "bg-accent/35")} />
  )
}

// ── Loading skeleton ────────────────────────────────────────────────────

function NoteListSkeleton() {
  return (
    <div className="px-3 space-y-0">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i}>
          <div className="flex h-[6.75rem] flex-col gap-1.5 px-3 py-2.5">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
            <div className="mt-auto flex justify-between">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
          <div className="h-px w-full bg-accent/35" />
        </div>
      ))}
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────

export function NotesPage() {
  const { isAuthenticated } = useNostr()
  const { notes, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useNotes()
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)

  const selectedNote = notes.find((n) => n.id === selectedNoteId) ?? null

  // Auto-select first note when notes load
  useEffect(() => {
    if (notes.length > 0 && !selectedNoteId) {
      setSelectedNoteId(notes[0].id)
    }
  }, [notes, selectedNoteId])

  // If the selected note was removed, fall back
  useEffect(() => {
    if (selectedNoteId && !notes.find((n) => n.id === selectedNoteId)) {
      setSelectedNoteId(notes.length > 0 ? notes[0].id : null)
    }
  }, [notes, selectedNoteId])

  // Infinite scroll observer
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el || !hasNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage()
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  if (!isAuthenticated && !isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin" />
          <p className="text-sm">Connecting to relay...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left pane: note list */}
      <div className="w-80 shrink-0 border-r border-border bg-muted/30 flex flex-col">
        <div className="px-4 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">Notes</h2>
            {!isLoading && notes.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {notes.length}
              </span>
            )}
          </div>
        </div>

        <ScrollArea className="flex-1">
          {isLoading && notes.length === 0 ? (
            <NoteListSkeleton />
          ) : notes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Inbox className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No notes yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Notes you publish from Comet will appear here
              </p>
            </div>
          ) : (
            <div className="px-3 space-y-0">
              {notes.map((note, i) => (
                <div key={note.id}>
                  {i > 0 && (
                    <NoteListSeparator
                      hidden={
                        note.id === selectedNoteId ||
                        notes[i - 1]?.id === selectedNoteId
                      }
                    />
                  )}
                  <NoteListItem
                    note={note}
                    isSelected={note.id === selectedNoteId}
                    onSelect={() => setSelectedNoteId(note.id)}
                  />
                </div>
              ))}
              <div ref={loadMoreRef} className="h-4" />
              {isFetchingNextPage && (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right pane: note detail */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedNote ? (
          <ScrollArea className="flex-1">
            <article className="max-w-2xl mx-auto px-8 py-8">
              <header className="mb-6 pb-6 border-b border-border/50">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {selectedNote.title || "Untitled"}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <time>{formatFullDate(selectedNote.modifiedAt)}</time>
                  {selectedNote.tags.length > 0 && (
                    <>
                      <span className="text-border">·</span>
                      {selectedNote.tags.map((tag) => (
                        <span key={tag} className="text-primary/80">
                          #{tag}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </header>
              <NoteMarkdown note={selectedNote} />
            </article>
          </ScrollArea>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <FileText className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-sm font-medium">No note selected</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose a note from the sidebar to start reading
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
