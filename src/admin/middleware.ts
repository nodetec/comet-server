import type { Context, Next } from "hono"
import { getCookie } from "hono/cookie"

const SESSION_COOKIE = "admin_session"

export function adminAuth(adminToken: string) {
  return async (c: Context, next: Next) => {
    // Check cookie session
    const session = getCookie(c, SESSION_COOKIE)
    if (session === adminToken) {
      await next()
      return
    }

    // Check Bearer token (for API access)
    const auth = c.req.header("Authorization")
    if (auth === `Bearer ${adminToken}`) {
      await next()
      return
    }

    // If requesting an API endpoint, return 401 JSON
    if (c.req.path.startsWith("/admin/api/")) {
      return c.json({ error: "unauthorized" }, 401)
    }

    // Otherwise redirect to login
    return c.redirect("/admin/login")
  }
}
