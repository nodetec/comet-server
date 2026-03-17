import type { FC } from "hono/jsx"
import { Layout } from "./layout"

type BlobEntry = {
  sha256: string
  size: number
  type: string | null
  uploaded_at: string
}

type BlobsProps = {
  blobs: BlobEntry[]
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

export const BlobsPage: FC<BlobsProps> = ({ blobs }) => {
  return (
    <Layout title="Blobs">
      <h1>Blob Storage</h1>

      <div class="card">
        <h2>All Blobs ({blobs.length})</h2>
        {blobs.length === 0 ? (
          <div class="empty">No blobs stored.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>SHA-256</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {blobs.map((b) => (
                <tr>
                  <td class="mono">{b.sha256.slice(0, 16)}…</td>
                  <td>{b.type || "—"}</td>
                  <td>{formatBytes(b.size)}</td>
                  <td>{new Date(b.uploaded_at).toISOString().slice(0, 16)}</td>
                  <td>
                    <form method="post" action="/admin/blobs/delete" style="display:inline">
                      <input type="hidden" name="sha256" value={b.sha256} />
                      <button type="submit" class="danger">Delete</button>
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
