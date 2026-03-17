import { useState, type FormEvent } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2, Shield } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetchAllowlist, addPubkey, revokePubkey } from "@/lib/api"

export function AllowlistPage() {
  const queryClient = useQueryClient()
  const [newPubkey, setNewPubkey] = useState("")

  const { data, isLoading } = useQuery({
    queryKey: ["allowlist"],
    queryFn: fetchAllowlist,
  })

  const addMutation = useMutation({
    mutationFn: (pubkey: string) => addPubkey(pubkey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["allowlist"] })
      setNewPubkey("")
    },
  })

  const revokeMutation = useMutation({
    mutationFn: revokePubkey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["allowlist"] })
    },
  })

  function handleAdd(e: FormEvent) {
    e.preventDefault()
    if (/^[a-f0-9]{64}$/.test(newPubkey)) {
      addMutation.mutate(newPubkey)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Allowlist</h1>
        <p className="text-sm text-muted-foreground">
          Manage pubkeys allowed to use the relay
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Add Pubkey
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex gap-2">
            <Input
              placeholder="64-character hex pubkey"
              value={newPubkey}
              onChange={(e) => setNewPubkey(e.target.value)}
              pattern="[a-f0-9]{64}"
              className="flex-1 font-mono text-sm"
            />
            <Button
              type="submit"
              disabled={!/^[a-f0-9]{64}$/.test(newPubkey) || addMutation.isPending}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </form>
          {addMutation.isError && (
            <p className="mt-2 text-sm text-destructive">
              Failed to add pubkey
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Allowed Pubkeys{" "}
            {data && (
              <span className="font-normal text-muted-foreground">
                ({data.pubkeys.length})
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
          ) : !data?.pubkeys.length ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No pubkeys on the allowlist.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pubkey</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.pubkeys.map((p) => (
                  <TableRow key={p.pubkey}>
                    <TableCell className="font-mono text-xs">
                      {p.pubkey.slice(0, 16)}...
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.expires_at
                        ? new Date(p.expires_at * 1000).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke access?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This pubkey will no longer be able to use the
                              relay.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() =>
                                revokeMutation.mutate(p.pubkey)
                              }
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
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
