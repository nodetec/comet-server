import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"

let client: S3Client | null = null
let bucketName: string = ""
let publicEndpoint: string = ""

export function initS3(): void {
  bucketName = process.env.BUCKET_NAME || "comet-blobs"
  publicEndpoint = process.env.BUCKET_PUBLIC_URL || ""

  client = new S3Client({
    region: process.env.AWS_REGION || "auto",
    endpoint: process.env.AWS_ENDPOINT_URL_S3 || undefined,
    forcePathStyle: true,
  })
}

export function getPublicUrl(sha256: string): string {
  if (publicEndpoint) {
    return `${publicEndpoint}/${sha256}`
  }
  return `https://${bucketName}.fly.storage.tigris.dev/${sha256}`
}

export async function uploadBlob(sha256: string, data: Uint8Array, contentType?: string): Promise<void> {
  if (!client) throw new Error("S3 client not initialized")
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: sha256,
    Body: data,
    ContentType: contentType || "application/octet-stream",
  }))
}

export async function getBlob(sha256: string): Promise<{ data: Uint8Array; contentType: string } | null> {
  if (!client) throw new Error("S3 client not initialized")
  try {
    const res = await client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: sha256,
    }))
    if (!res.Body) return null
    const bytes = await res.Body.transformToByteArray()
    return { data: bytes, contentType: res.ContentType || "application/octet-stream" }
  } catch (e: unknown) {
    if ((e as { name?: string }).name === "NoSuchKey") return null
    throw e
  }
}

export async function deleteBlob(sha256: string): Promise<void> {
  if (!client) throw new Error("S3 client not initialized")
  await client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: sha256,
  }))
}
