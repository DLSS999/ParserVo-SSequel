import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  recordBrowserHeartbeat,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";
import {
  normalizeYnapCapture,
  type YnapBrowserCapture,
} from "../services/ynap-capture-normalizer.server";
import { storeYnapCapture } from "../services/ynap-catalog-store.server";
import { createStoredAdminClient } from "../services/shopify-stored-admin.server";
import { syncProductToShopify } from "../services/shopify-sync.server";

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
  return response({
    ok: true,
    name: "ParserVo NET-A-PORTER / MR PORTER capture API",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const payload = JSON.parse((await request.text()) || "{}") as {
      shop?: string;
      token?: string;
      agentId?: string;
      version?: string;
      capture?: YnapBrowserCapture;
    };

    const shop = String(payload.shop || "").trim().toLowerCase();
    const suppliedKey = String(
      request.headers.get("X-ParserVo-Token") || payload.token || "",
    ).trim();

    if (!shop || !verifyBrowserCaptureKey(shop, suppliedKey)) {
      return response({ ok: false, error: "Invalid shop or browser capture key." }, 401);
    }

    if (!payload.capture) {
      return response({ ok: false, error: "Missing product capture payload." }, 400);
    }

    const normalized = normalizeYnapCapture(payload.capture);
    const stored = await storeYnapCapture(normalized);

    let shopify: unknown = null;
    let shopifyError: string | null = null;

    try {
      const admin = await createStoredAdminClient(shop);
      shopify = await syncProductToShopify(admin, normalized.product, {
        eurRate: Number(payload.capture.rates?.eur || 45),
        plnRate: Number(payload.capture.rates?.pln || 12.19),
        defaultQuantity: 5,
      });
    } catch (error) {
      shopifyError = error instanceof Error ? error.message : String(error);
    }

    await recordBrowserHeartbeat({
      shopDomain: shop,
      agentId: String(payload.agentId || "chrome-extension"),
      version: payload.version,
      status: "BUSY",
      message: `Captured ${normalized.product.brand} ${normalized.product.title}`,
      currentJobId: payload.capture.jobId || null,
    });

    return response({
      ok: true,
      product: {
        handle: stored.handle,
        brand: normalized.product.brand,
        title: normalized.product.title,
        availableVariants: stored.availableVariants,
        images: stored.images,
        videos: stored.videos,
      },
      shopify,
      shopifyError,
    });
  } catch (error) {
    return response({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown capture error",
    }, 500);
  }
}
