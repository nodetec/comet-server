import { useQuery } from "@tanstack/react-query"
import { Users } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { fetchUsers } from "@/lib/api"

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

function usagePercent(used: number, limit: number): number {
  if (limit === 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

function usageColor(pct: number): string {
  if (pct >= 95) return "bg-destructive"
  if (pct >= 80) return "bg-yellow-500"
  return "bg-primary"
}

export function UsersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: fetchUsers,
    refetchInterval: 10000,
  })

  const defaultLimit = data?.default_storage_limit_bytes ?? 1024 * 1024 * 1024

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Per-user storage and event usage
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            All Users{" "}
            {data && (
              <span className="font-normal text-muted-foreground">
                ({data.users.length})
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
          ) : !data?.users.length ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No users found.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pubkey</TableHead>
                  <TableHead>Storage</TableHead>
                  <TableHead className="text-right">Blobs</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.users.map((user) => {
                  const limit = user.storage_limit_bytes ?? defaultLimit
                  const pct = usagePercent(user.storage_used_bytes, limit)
                  return (
                    <TableRow key={user.pubkey}>
                      <TableCell className="font-mono text-xs">
                        {user.pubkey.slice(0, 16)}...
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span>
                              {formatBytes(user.storage_used_bytes)} /{" "}
                              {formatBytes(limit)}
                            </span>
                            {user.storage_limit_bytes !== null && (
                              <Badge variant="outline" className="text-[10px] px-1 py-0">
                                custom
                              </Badge>
                            )}
                          </div>
                          <div className="h-1.5 w-full max-w-[200px] rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full transition-all ${usageColor(pct)}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {user.blob_count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {user.event_count.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
