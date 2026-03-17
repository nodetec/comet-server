import { useState } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowUpDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/data-table"
import { fetchEvents, type EventEntry } from "@/lib/api"
import { formatTimestamp } from "@/lib/utils"

const KIND_LABELS: Record<number, string> = {
  0: "Metadata",
  1: "Note",
  3: "Contacts",
  4: "DM",
  5: "Delete",
  7: "Reaction",
  9: "Delete",
  23: "Long-form",
  1059: "Gift Wrap",
  10002: "Relay List",
  24242: "Blossom Auth",
  30023: "Long-form",
}

function kindLabel(kind: number) {
  return KIND_LABELS[kind] ?? `Kind ${kind}`
}

const columns: ColumnDef<EventEntry>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {row.original.id.slice(0, 16)}...
      </span>
    ),
  },
  {
    accessorKey: "kind",
    header: "Kind",
    cell: ({ row }) => (
      <Badge variant="secondary">{kindLabel(row.original.kind)}</Badge>
    ),
  },
  {
    accessorKey: "pubkey",
    header: "Pubkey",
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {row.original.pubkey.slice(0, 12)}...
      </span>
    ),
  },
  {
    accessorKey: "content",
    header: "Content",
    cell: ({ row }) => (
      <span className="max-w-[300px] truncate text-xs text-muted-foreground block">
        {row.original.content || "—"}
      </span>
    ),
  },
  {
    accessorKey: "created_at",
    header: ({ column }) => (
      <Button
        variant="ghost"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Created <ArrowUpDown className="ml-1 h-3 w-3" />
      </Button>
    ),
    cell: ({ row }) => (
      <span className="text-right text-xs text-muted-foreground block">
        {formatTimestamp(row.original.created_at)}
      </span>
    ),
  },
]

export function EventsPage() {
  const [kindFilter, setKindFilter] = useState("")
  const [pubkeyFilter, setPubkeyFilter] = useState("")

  const params: { kind?: number; pubkey?: string } = {}
  if (kindFilter && !isNaN(Number(kindFilter))) params.kind = Number(kindFilter)
  if (pubkeyFilter && /^[a-f0-9]{64}$/.test(pubkeyFilter))
    params.pubkey = pubkeyFilter

  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["events", params],
      queryFn: ({ pageParam }) => fetchEvents({ ...params, cursor: pageParam }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    })

  const allEvents = data?.pages.flatMap((p) => p.events) ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="text-sm text-muted-foreground">
          Browse stored Nostr events
          {allEvents.length > 0 && (
            <span className="ml-1">
              ({allEvents.length}{hasNextPage ? "+" : ""})
            </span>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          placeholder="Filter by kind..."
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="sm:w-40"
        />
        <Input
          placeholder="Filter by pubkey (64-char hex)..."
          value={pubkeyFilter}
          onChange={(e) => setPubkeyFilter(e.target.value)}
          className="flex-1"
        />
      </div>

      <DataTable
        columns={columns}
        data={allEvents}
        emptyMessage="No events found."
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => fetchNextPage()}
      />
    </div>
  )
}
