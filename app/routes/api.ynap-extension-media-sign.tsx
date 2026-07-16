import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { verifyBrowserCaptureKey } from "../services/browser-capture.server";
import { createParserVoSignedMediaUpload } from "../services/supabase-signed-media.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-ParserVo-Token",
  "Cache-Control": "no-store",
};

function response(data: unknown, status = 200) {
  return json(data, { status, headers: corsHeaders });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return response({ ok: true, name: "ParserVo signed media upload API" });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const payload = JSON.parse((await request.text()) || "{}") as {
      shop?: string;
      token?: string;
      handle?: string;
      kind?: "image" | "video";
      position?: number;
      contentType?: string;
      byteLength?: number;
      originalUrl?: string;
      filename?: string;
    };

    const shop = String(payload.shop || "").trim().toLowerCase();
    const suppliedKey = String(
      request.headers.get("X-ParserVo-Token") || payload.token || "",
    ).trim();

    if (!shop || !verifyBrowserCaptureKey(shop, suppliedKey)) {
      return response({ ok: false, error: "Invalid shop or browser capture key." }, 401);
    }

    const kind = payload.kind === "video" ? "video" : "image";
    const upload = await createParserVoSignedMediaUpload({
      shop,
      handle: String(payload.handle || "product"),
      kind,
      position: Number(payload.position || 1),
      contentType: String(payload.contentType || ""),
      byteLength: Number(payload.byteLength || 0),
      originalUrl: payload.originalUrl || null,
      filename: payload.filename || null,
    });

    return response({ ok: true, upload });
  } catch (error) {
    return response({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown signed media upload error",
    }, 500);
  }
}
