import { createHash } from "node:crypto";

const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";
const BUCKET = "parservo-media";

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not configured in Vercel.");
  return { url, key };
}

function authHeaders(key: string) {
  const headers: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
    "x-upsert": "true",
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
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

function extensionFor(contentType: string, filename?: string | null) {
  const mime = String(contentType || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("avif")) return "avif";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("mp4")) return "mp4";

  const lower = String(filename || "").toLowerCase();
  const fileMatch = lower.match(/\.([a-z0-9]{2,5})(?:$|\?)/i);
  if (fileMatch) {
    const ext = fileMatch[1];
    if (["jpg", "jpeg", "png", "webp", "avif", "mp4", "webm", "mov"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }

  return mime.startsWith("video/") ? "mp4" : "jpg";
}

function encodePath(path: string) {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function limits(kind: "image" | "video") {
  return kind === "video"
    ? { maxBytes: 50 * 1024 * 1024, allowed: /^video\/(mp4|webm|quicktime)$/i }
    : { maxBytes: 8 * 1024 * 1024, allowed: /^image\/(jpeg|jpg|png|webp|avif)$/i };
}

export async function createParserVoSignedMediaUpload(input: {
  shop: string;
  handle: string;
  kind: "image" | "video";
  position: number;
  contentType: string;
  byteLength: number;
  originalUrl?: string | null;
  filename?: string | null;
}) {
  const { url, key } = config();
  const rule = limits(input.kind);
  const mime = String(input.contentType || "").split(";")[0].toLowerCase();
  const byteLength = Math.max(0, Math.trunc(Number(input.byteLength || 0)));

  if (!rule.allowed.test(mime)) throw new Error(`Unsupported ${input.kind} MIME type: ${mime}`);
  if (!byteLength) throw new Error("Media file is empty.");
  if (byteLength > rule.maxBytes) {
    throw new Error(`${input.kind === "video" ? "Video" : "Image"} exceeds ${Math.round(rule.maxBytes / 1024 / 1024)} MB limit.`);
  }

  const digest = createHash("sha256")
    .update(`${input.originalUrl || ""}|${input.filename || ""}|${byteLength}|${mime}`)
    .digest("hex")
    .slice(0, 16);
  const extension = extensionFor(mime, input.filename || input.originalUrl);
  const objectPath = [
    safePart(input.shop.replace(/\.myshopify\.com$/i, ""), "shop"),
    safePart(input.handle, "product"),
    `${input.kind}-${Math.max(1, Math.trunc(input.position))}-${digest}.${extension}`,
  ].join("/");

  const signResponse = await fetch(
    `${url}/storage/v1/object/upload/sign/${BUCKET}/${encodePath(objectPath)}`,
    {
      method: "POST",
      headers: authHeaders(key),
      body: "{}",
    },
  );
  const text = await signResponse.text();
  if (!signResponse.ok) {
    throw new Error(`Supabase signed upload ${signResponse.status}: ${text.slice(0, 500)}`);
  }

  const data = JSON.parse(text || "{}");
  const relativeUrl = String(data.url || "");
  if (!relativeUrl) throw new Error("Supabase did not return a signed upload URL.");

  const signedUrl = relativeUrl.startsWith("http")
    ? relativeUrl
    : `${url}/storage/v1${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
  const publicUrl = `${url}/storage/v1/object/public/${BUCKET}/${encodePath(objectPath)}`;

  return {
    bucket: BUCKET,
    path: objectPath,
    signedUrl,
    publicUrl,
    contentType: mime,
    byteLength,
    kind: input.kind,
  };
}
