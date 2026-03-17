import type { FC, PropsWithChildren } from "hono/jsx"

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — Comet Admin</title>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f10; color: #e4e4e7; line-height: 1.5; }
          a { color: #a78bfa; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .container { max-width: 960px; margin: 0 auto; padding: 2rem 1rem; }
          nav { display: flex; gap: 1.5rem; padding: 1rem 0; border-bottom: 1px solid #27272a; margin-bottom: 2rem; align-items: center; }
          nav .brand { font-weight: 700; color: #fff; margin-right: auto; }
          h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #fff; }
          h2 { font-size: 1.125rem; margin-bottom: 0.75rem; color: #d4d4d8; }
          .card { background: #18181b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 1.25rem; margin-bottom: 1rem; }
          .stat { font-size: 2rem; font-weight: 700; color: #fff; }
          .stat-label { font-size: 0.875rem; color: #71717a; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #27272a; font-size: 0.875rem; }
          th { color: #a1a1aa; font-weight: 500; }
          td { color: #e4e4e7; }
          .mono { font-family: 'SF Mono', Monaco, monospace; font-size: 0.8125rem; }
          input, button { font-size: 0.875rem; padding: 0.5rem 0.75rem; border-radius: 0.375rem; border: 1px solid #3f3f46; background: #27272a; color: #e4e4e7; }
          input:focus { outline: 2px solid #7c3aed; border-color: transparent; }
          button { cursor: pointer; background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 500; }
          button:hover { background: #6d28d9; }
          button.danger { background: #dc2626; border-color: #dc2626; }
          button.danger:hover { background: #b91c1c; }
          .form-row { display: flex; gap: 0.5rem; margin-bottom: 1rem; align-items: center; }
          .form-row input { flex: 1; }
          .empty { color: #71717a; font-style: italic; padding: 1rem 0; }
        `}</style>
      </head>
      <body>
        <div class="container">
          <nav>
            <span class="brand">Comet Admin</span>
            <a href="/admin">Dashboard</a>
            <a href="/admin/allowlist">Allowlist</a>
            <a href="/admin/blobs">Blobs</a>
            <a href="/admin/logout">Logout</a>
          </nav>
          {children}
        </div>
      </body>
    </html>
  )
}
