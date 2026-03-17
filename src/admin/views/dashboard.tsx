import type { FC } from "hono/jsx"
import { Layout } from "./layout"

type DashboardProps = {
  connectionCount: number
  eventCount: number
  blobCount: number
  blobTotalSize: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

export const DashboardPage: FC<DashboardProps> = (props) => {
  return (
    <Layout title="Dashboard">
      <h1>Dashboard</h1>
      <div class="grid">
        <div class="card">
          <div class="stat">{props.connectionCount}</div>
          <div class="stat-label">Active Connections</div>
        </div>
        <div class="card">
          <div class="stat">{props.eventCount}</div>
          <div class="stat-label">Stored Events</div>
        </div>
        <div class="card">
          <div class="stat">{props.blobCount}</div>
          <div class="stat-label">Blobs</div>
        </div>
        <div class="card">
          <div class="stat">{formatBytes(props.blobTotalSize)}</div>
          <div class="stat-label">Blob Storage</div>
        </div>
      </div>
    </Layout>
  )
}
