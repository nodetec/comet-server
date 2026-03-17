import type { FC } from "hono/jsx"

export const LoginPage: FC<{ error?: string }> = ({ error }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Login — Comet Admin</title>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f10; color: #e4e4e7; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .login-box { background: #18181b; border: 1px solid #27272a; border-radius: 0.75rem; padding: 2rem; width: 100%; max-width: 360px; }
          h1 { font-size: 1.25rem; color: #fff; margin-bottom: 1.5rem; text-align: center; }
          input, button { display: block; width: 100%; font-size: 0.875rem; padding: 0.625rem 0.75rem; border-radius: 0.375rem; border: 1px solid #3f3f46; background: #27272a; color: #e4e4e7; margin-bottom: 1rem; }
          input:focus { outline: 2px solid #7c3aed; border-color: transparent; }
          button { cursor: pointer; background: #7c3aed; border-color: #7c3aed; color: #fff; font-weight: 500; }
          button:hover { background: #6d28d9; }
          .error { color: #ef4444; font-size: 0.8125rem; margin-bottom: 1rem; text-align: center; }
        `}</style>
      </head>
      <body>
        <div class="login-box">
          <h1>Comet Admin</h1>
          {error && <div class="error">{error}</div>}
          <form method="post" action="/admin/login">
            <input type="password" name="token" placeholder="Admin token" autocomplete="current-password" required />
            <button type="submit">Sign in</button>
          </form>
        </div>
      </body>
    </html>
  )
}
