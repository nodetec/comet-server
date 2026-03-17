import { useQuery } from "@tanstack/react-query"
import { Wifi } from "lucide-react"
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
import { fetchConnections } from "@/lib/api"

export function ConnectionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
    refetchInterval: 3000,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Live WebSocket connections to the relay
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wifi className="h-4 w-4" />
            Active Connections{" "}
            {data && (
              <span className="font-normal text-muted-foreground">
                ({data.connections.length})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !data?.connections.length ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No active connections.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connection ID</TableHead>
                  <TableHead>Authenticated Pubkeys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.connections.map((conn) => (
                  <TableRow key={conn.id}>
                    <TableCell className="font-mono text-xs">
                      {conn.id.slice(0, 8)}...
                    </TableCell>
                    <TableCell>
                      {conn.authedPubkeys.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          Not authenticated
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {conn.authedPubkeys.map((pk) => (
                            <Badge
                              key={pk}
                              variant="secondary"
                              className="font-mono text-xs"
                            >
                              {pk.slice(0, 12)}...
                            </Badge>
                          ))}
                        </div>
                      )}
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
