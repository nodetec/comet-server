import { useState, type FormEvent } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2, Shield, Pencil } from "lucide-react"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { nip19 } from "nostr-tools"
import {
  fetchAllowlist,
  addPubkey,
  revokePubkey,
  setStorageLimit,
  type AllowedPubkey,
} from "@/lib/api"

/** Resolve an npub or hex string to a hex pubkey, or null if invalid. */
function resolveToHex(input: string): string | null {
  const trimmed = input.trim()
  if (/^[a-f0-9]{64}$/.test(trimmed)) return trimmed
  if (trimmed.startsWith("npub1")) {
    try {
      const { type, data } = nip19.decode(trimmed)
      if (type === "npub") return data
    } catch {
      return null
    }
  }
  return null
}

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

function StorageLimitEditor({
  pubkey,
  currentLimit,
  defaultLimit,
}: {
  pubkey: AllowedPubkey
  currentLimit: number
  defaultLimit: number
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [limitGB, setLimitGB] = useState(
    String(currentLimit / (1024 * 1024 * 1024))
  )

  const mutation = useMutation({
    mutationFn: (limitBytes: number | null) =>
      setStorageLimit(pubkey.pubkey, limitBytes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["allowlist"] })
      setOpen(false)
    },
  })

  function handleSave() {
    const gb = parseFloat(limitGB)
    if (isNaN(gb) || gb <= 0) return
    mutation.mutate(Math.round(gb * 1024 * 1024 * 1024))
  }

  function handleReset() {
    mutation.mutate(null)
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={() => {
          setLimitGB(String(currentLimit / (1024 * 1024 * 1024)))
          setOpen(true)
        }}
      >
        <Pencil className="h-3 w-3" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Storage Limit</DialogTitle>
            <DialogDescription>
              Set a custom storage limit for{" "}
              <code className="text-xs">{pubkey.pubkey.slice(0, 16)}...</code>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step="0.1"
                min="0.1"
                value={limitGB}
                onChange={(e) => setLimitGB(e.target.value)}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">GB</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Default: {formatBytes(defaultLimit)}. Current usage:{" "}
              {formatBytes(pubkey.storage_used_bytes)}.
            </p>
          </div>
          <DialogFooter className="flex gap-2">
            {pubkey.storage_limit_bytes !== null && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={mutation.isPending}
              >
                Reset to default
              </Button>
            )}
            <Button onClick={handleSave} disabled={mutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function AllowlistPage() {
  const queryClient = useQueryClient()
  const [newPubkey, setNewPubkey] = useState("")

  const { data, isLoading } = useQuery({
    queryKey: ["allowlist"],
    queryFn: fetchAllowlist,
  })

  const defaultLimit = data?.default_storage_limit_bytes ?? 1024 * 1024 * 1024

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
    const hex = resolveToHex(newPubkey)
    if (hex) {
      addMutation.mutate(hex)
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
              placeholder="npub or hex pubkey"
              value={newPubkey}
              onChange={(e) => setNewPubkey(e.target.value)}
              className="flex-1 font-mono text-sm"
            />
            <Button
              type="submit"
              disabled={!resolveToHex(newPubkey) || addMutation.isPending}
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
                  <TableHead>Storage</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.pubkeys.map((p) => {
                  const limit = p.storage_limit_bytes ?? defaultLimit
                  const pct = usagePercent(p.storage_used_bytes, limit)
                  return (
                    <TableRow key={p.pubkey}>
                      <TableCell className="font-mono text-xs">
                        {p.pubkey.slice(0, 16)}...
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span>
                              {formatBytes(p.storage_used_bytes)} /{" "}
                              {formatBytes(limit)}
                            </span>
                            {p.storage_limit_bytes !== null && (
                              <span className="text-muted-foreground">
                                (custom)
                              </span>
                            )}
                            <StorageLimitEditor
                              pubkey={p}
                              currentLimit={limit}
                              defaultLimit={defaultLimit}
                            />
                          </div>
                          <div className="h-1.5 w-full max-w-[200px] rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full transition-all ${usageColor(pct)}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
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
                              <AlertDialogTitle>
                                Revoke access?
                              </AlertDialogTitle>
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
