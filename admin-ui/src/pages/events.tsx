import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetchEvents } from "@/lib/api"

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

function formatTimestamp(ts: number) {
  return new Date(ts * 1000).toLocaleString()
}

export function EventsPage() {
  const [kindFilter, setKindFilter] = useState("")
  const [pubkeyFilter, setPubkeyFilter] = useState("")

  const params: { kind?: number; pubkey?: string } = {}
  if (kindFilter && !isNaN(Number(kindFilter))) params.kind = Number(kindFilter)
  if (pubkeyFilter && /^[a-f0-9]{64}$/.test(pubkeyFilter))
    params.pubkey = pubkeyFilter

  const { data, isLoading } = useQuery({
    queryKey: ["events", params],
    queryFn: () => fetchEvents(params),
    refetchInterval: 10000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="text-sm text-muted-foreground">
          Browse stored Nostr events
        </p>
      </div>

      <div className="flex gap-3">
        <Input
          placeholder="Filter by kind..."
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="w-40"
        />
        <Input
          placeholder="Filter by pubkey (64-char hex)..."
          value={pubkeyFilter}
          onChange={(e) => setPubkeyFilter(e.target.value)}
          className="flex-1"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Events{" "}
            {data && (
              <span className="font-normal text-muted-foreground">
                ({data.events.length})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !data?.events.length ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No events found.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">ID</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Pubkey</TableHead>
                  <TableHead>Content</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.events.map((evt) => (
                  <TableRow key={evt.id}>
                    <TableCell className="font-mono text-xs">
                      {evt.id.slice(0, 16)}...
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{kindLabel(evt.kind)}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {evt.pubkey.slice(0, 12)}...
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate text-xs text-muted-foreground">
                      {evt.content || "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {formatTimestamp(evt.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
