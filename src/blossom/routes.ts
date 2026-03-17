import { Hono } from "hono"
import type { DB } from "../db"
import { validateBlossomAuth } from "./auth"
import * as blobDb from "./db"
import * as s3 from "./s3"

/** Extract the 64-char hex sha256 from a path param that may have a file extension (e.g. "abc123.png"). */
function parseSha256(param: string): string | null {
  const sha256 = param.replace(/\.[^.]+$/, "")
  return /^[a-f0-9]{64}$/.test(sha256) ? sha256 : null
}

export function blossomRoutes(db: DB): Hono {
  const app = new Hono()

  // GET /:sha256 or /:sha256.ext — redirect to public blob URL
  app.get("/:blob{[a-f0-9]{64}.*}", async (c) => {
    const sha256 = parseSha256(c.req.param("blob"))
    if (!sha256) return c.json({ error: "invalid hash" }, 400)
    const blob = await blobDb.getBlob(db, sha256)
    if (!blob) {
      console.log(`[BLOSSOM] GET ${sha256.slice(0, 8)}… not found`)
      return c.json({ error: "not found" }, 404)
    }
    console.log(`[BLOSSOM] GET ${sha256.slice(0, 8)}… → redirect`)
    return c.redirect(s3.getPublicUrl(sha256), 302)
  })

  // HEAD /:sha256 or /:sha256.ext — return metadata headers
  app.on("HEAD", "/:blob{[a-f0-9]{64}.*}", async (c) => {
    const sha256 = parseSha256(c.req.param("blob"))
    if (!sha256) return c.body(null, 400)
    const blob = await blobDb.getBlob(db, sha256)
    if (!blob) {
      return c.body(null, 404)
    }
    return c.body(null, 200, {
      "Content-Type": blob.type || "application/octet-stream",
      "Content-Length": String(blob.size),
      "X-Content-Sha256": sha256,
    })
  })

  // PUT /upload — upload a blob
  app.put("/upload", async (c) => {
    console.log(`[BLOSSOM] upload request from ${c.req.header("Authorization")?.slice(0, 20)}…`)
    const auth = validateBlossomAuth(c.req.header("Authorization"), "upload")
    if (!auth.ok) {
      console.log(`[BLOSSOM] upload auth failed: ${auth.reason}`)
      return c.json({ error: auth.reason }, 401)
    }
    console.log(`[BLOSSOM] upload authorized pubkey=${auth.pubkey!.slice(0, 8)}…`)

    const body = await c.req.arrayBuffer()
    if (body.byteLength === 0) {
      console.log(`[BLOSSOM] upload rejected: empty body`)
      return c.json({ error: "empty body" }, 400)
    }

    const data = new Uint8Array(body)
    console.log(`[BLOSSOM] upload received ${data.byteLength} bytes, type=${c.req.header("Content-Type")}`)

    // Compute SHA-256 hash
    const hashBuffer = await crypto.subtle.digest("SHA-256", data)
    const sha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")

    const contentType = c.req.header("Content-Type") || "application/octet-stream"

    // Upload to S3
    try {
      await s3.uploadBlob(sha256, data, contentType)
      console.log(`[BLOSSOM] S3 upload ok sha256=${sha256.slice(0, 8)}…`)
    } catch (e) {
      console.error(`[BLOSSOM] S3 upload failed:`, e)
      return c.json({ error: "storage upload failed" }, 500)
    }

    // Record in database
    await blobDb.insertBlob(db, sha256, data.byteLength, contentType, auth.pubkey!)
    console.log(`[BLOSSOM] saved sha256=${sha256.slice(0, 8)}… size=${data.byteLength} type=${contentType} pubkey=${auth.pubkey!.slice(0, 8)}…`)

    return c.json({
      url: s3.getPublicUrl(sha256),
      sha256,
      size: data.byteLength,
      type: contentType,
      uploaded: Math.floor(Date.now() / 1000),
    }, 200)
  })

  // DELETE /:sha256 — delete a blob (remove owner, cleanup if no owners remain)
  app.delete("/:blob{[a-f0-9]{64}.*}", async (c) => {
    const sha256 = parseSha256(c.req.param("blob"))
    if (!sha256) return c.json({ error: "invalid hash" }, 400)
    const auth = validateBlossomAuth(c.req.header("Authorization"), "delete", { sha256 })
    if (!auth.ok) {
      console.log(`[BLOSSOM] DELETE ${sha256.slice(0, 8)}… auth failed: ${auth.reason}`)
      return c.json({ error: auth.reason }, 401)
    }
    console.log(`[BLOSSOM] DELETE ${sha256.slice(0, 8)}… by pubkey=${auth.pubkey!.slice(0, 8)}…`)

    const blob = await blobDb.getBlob(db, sha256)
    if (!blob) {
      return c.json({ error: "not found" }, 404)
    }

    const noOwnersRemain = await blobDb.removeOwner(db, sha256, auth.pubkey!)
    if (noOwnersRemain) {
      await s3.deleteBlob(sha256)
      await blobDb.deleteBlob(db, sha256)
    }

    return c.json({ deleted: true })
  })

  // GET /list/:pubkey — list blobs owned by a pubkey
  app.get("/list/:pubkey{[a-f0-9]{64}}", async (c) => {
    const pubkey = c.req.param("pubkey")
    const auth = validateBlossomAuth(c.req.header("Authorization"), "list")
    if (!auth.ok) {
      return c.json({ error: auth.reason }, 401)
    }

    const blobs = await blobDb.listBlobsByPubkey(db, pubkey)
    return c.json(blobs.map((b) => ({
      url: s3.getPublicUrl(b.sha256),
      sha256: b.sha256,
      size: b.size,
      type: b.type,
      uploaded: Math.floor(new Date(b.uploaded_at).getTime() / 1000),
    })))
  })

  return app
}
