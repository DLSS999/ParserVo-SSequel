import { createHash } from "node:crypto";

const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";
const BUCKET = "parservo-media";

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not configured in Vercel.");
  return { url, key };
}

function safePart(value: string, fallback: string) {
  const clean = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return clean || fallback;
}

function extensionFor(contentType: string) {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  if (/avif/i.test(contentType)) return "avif";
  return "jpg";
}

function encodePath(path: string) {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export async function uploadParserVoImage(input: {
  shop: string;
  handle: string;
  position: number;
  contentType: string;
  bytes: ArrayBuffer;
  originalUrl?: string | null;
}) {
  const { url, key } = config();
  const byteLength = input.bytes.byteLength;
  if (byteLength <= 0) throw new Error("Image upload is empty.");
  if (byteLength > 8 * 1024 * 1024) throw new Error("Image exceeds 8 MB storage limit.");

  const mime = String(input.contentType || "image/jpeg").split(";")[0].toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp|avif)$/.test(mime)) {
    throw new Error(`Unsupported image type: ${mime}`);
  }

  const digest = createHash("sha256")
    .update(Buffer.from(input.bytes))
    .digest("hex")
    .slice(0, 16);
  const extension = extensionFor(mime);
  const objectPath = [
    safePart(input.shop.replace(/\.myshopify\.com$/i, ""), "shop"),
    safePart(input.handle, "product"),
    `${Math.max(1, Math.trunc(input.position))}-${digest}.${extension}`,
  ].join("/");

  const response = await fetch(
    `${url}/storage/v1/object/${BUCKET}/${encodePath(objectPath)}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": mime,
        "x-upsert": "true",
        "Cache-Control": "31536000",
      },
      body: input.bytes,
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase media upload ${response.status}: ${text.slice(0, 500)}`);
  }

  return {
    bucket: BUCKET,
    path: objectPath,
    url: `${url}/storage/v1/object/public/${BUCKET}/${encodePath(objectPath)}`,
    contentType: mime,
    byteLength,
    originalUrl: input.originalUrl || null,
  };
}
