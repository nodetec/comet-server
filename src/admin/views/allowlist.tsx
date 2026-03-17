import type { FC } from "hono/jsx"
import { Layout } from "./layout"

type AllowlistProps = {
  pubkeys: Array<{ pubkey: string; expires_at: number | null }>
}

export const AllowlistPage: FC<AllowlistProps> = ({ pubkeys }) => {
  return (
    <Layout title="Allowlist">
      <h1>Allowlist</h1>

      <div class="card">
        <h2>Add Pubkey</h2>
        <form method="post" action="/admin/allowlist/add">
          <div class="form-row">
            <input type="text" name="pubkey" placeholder="64-char hex pubkey" pattern="[a-f0-9]{'{'}64{'}'}" required />
            <button type="submit">Add</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Allowed Pubkeys ({pubkeys.length})</h2>
        {pubkeys.length === 0 ? (
          <div class="empty">No pubkeys on the allowlist.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Pubkey</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pubkeys.map((p) => (
                <tr>
                  <td class="mono">{p.pubkey.slice(0, 16)}…</td>
                  <td>{p.expires_at ? new Date(p.expires_at * 1000).toISOString() : "Never"}</td>
                  <td>
                    <form method="post" action="/admin/allowlist/revoke" style="display:inline">
                      <input type="hidden" name="pubkey" value={p.pubkey} />
                      <button type="submit" class="danger">Revoke</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  )
}
