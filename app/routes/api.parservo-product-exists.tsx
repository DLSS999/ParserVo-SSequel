import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  databaseAdminRequest,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-ParserVo-Token",
  "Cache-Control": "no-store",
};

function reply(data: unknown, status = 200) {
  return json(data, { status, headers: corsHeaders });
}

function productCodeFromUrl(value: string) {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    return pathname.match(/(?:^|[-/])(L[A-Z0-9]{12,})(?:\.html?)?$/i)?.[1]?.toUpperCase() || "";
  } catch {
    return "";
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return reply({ ok: true, name: "ParserVo product existence API" });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const payload = JSON.parse((await request.text()) || "{}") as Record<string, unknown>;
    const shop = String(payload.shop || "").trim().toLowerCase();
    const token = String(request.headers.get("X-ParserVo-Token") || payload.token || "").trim();
    const sourceUrl = String(payload.sourceUrl || "").trim();

    if (!shop || !verifyBrowserCaptureKey(shop, token)) {
      return reply({ ok: false, error: "Invalid shop or browser capture key." }, 401);
    }
    if (!/^https:\/\/(?:www\.)?stoneisland\.com\//i.test(sourceUrl)) {
      return reply({ ok: false, error: "Invalid Stone Island product URL." }, 400);
    }

    const productCode = productCodeFromUrl(sourceUrl);
    const path = productCode
      ? `parservo_products?source=eq.STONE_ISLAND&product_code=eq.${encodeURIComponent(productCode)}&shopify_product_gid=not.is.null&select=handle,product_code,shopify_product_gid&limit=1`
      : `parservo_products?source=eq.STONE_ISLAND&source_url=eq.${encodeURIComponent(sourceUrl)}&shopify_product_gid=not.is.null&select=handle,product_code,shopify_product_gid&limit=1`;
    const rows = await databaseAdminRequest(path) as Array<Record<string, unknown>>;
    const product = Array.isArray(rows) ? rows[0] || null : null;

    return reply({
      ok: true,
      exists: Boolean(product),
      productCode,
      product,
    });
  } catch (error) {
    return reply({
      ok: false,
      error: error instanceof Error ? error.message : "Product existence check failed.",
    }, 500);
  }
}
