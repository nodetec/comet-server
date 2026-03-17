import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Ticket, Copy, Check, Ban } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
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
import {
  fetchInviteCodes,
  createInviteCode,
  revokeInviteCode,
  type InviteCode,
} from "@/lib/api"

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopy}>
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  )
}

function codeStatus(code: InviteCode): { label: string; variant: "default" | "secondary" | "destructive" | "outline" } {
  if (code.revoked) return { label: "Revoked", variant: "destructive" }
  if (code.expires_at && code.expires_at < Math.floor(Date.now() / 1000))
    return { label: "Expired", variant: "secondary" }
  if (code.use_count >= code.max_uses) return { label: "Used", variant: "secondary" }
  return { label: "Active", variant: "default" }
}

export function InviteCodesPage() {
  const queryClient = useQueryClient()
  const [maxUses, setMaxUses] = useState("1")
  const [newCode, setNewCode] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ["invite-codes"],
    queryFn: fetchInviteCodes,
  })

  const createMutation = useMutation({
    mutationFn: () => createInviteCode({ max_uses: parseInt(maxUses, 10) || 1 }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invite-codes"] })
      setNewCode(data.code)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: revokeInviteCode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invite-codes"] })
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invite Codes</h1>
        <p className="text-sm text-muted-foreground">
          Create and manage invite codes for new users
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Ticket className="h-4 w-4" />
            Create Invite Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Max uses:</span>
              <Input
                type="number"
                min="1"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                className="w-20"
              />
            </div>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
            >
              <Plus className="mr-1 h-4 w-4" />
              Create
            </Button>
          </div>
          {newCode && (
            <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 p-3">
              <code className="flex-1 font-mono text-sm font-semibold">
                {newCode}
              </code>
              <CopyButton text={newCode} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            All Codes{" "}
            {data && (
              <span className="font-normal text-muted-foreground">
                ({data.invite_codes.length})
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
          ) : !data?.invite_codes.length ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No invite codes created yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Uses</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.invite_codes.map((code) => {
                  const status = codeStatus(code)
                  return (
                    <TableRow key={code.id}>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <code className="font-mono text-xs">
                            {code.code}
                          </code>
                          <CopyButton text={code.code} />
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {code.use_count} / {code.max_uses}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(code.created_at * 1000).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        {!code.revoked && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <Ban className="h-4 w-4 text-destructive" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Revoke invite code?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  This code will no longer be usable. Users who
                                  already redeemed it will not be affected.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() =>
                                    revokeMutation.mutate(code.id)
                                  }
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Revoke
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
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
