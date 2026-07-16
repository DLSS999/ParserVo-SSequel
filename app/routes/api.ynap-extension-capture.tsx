import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  databaseAdminHeaders,
  databaseAdminRequest,
  recordBrowserHeartbeat,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";
import { markCrawlLinkSuccess } from "../services/crawl-link-queue.server";
import {
  normalizeYnapCapture,
  type YnapBrowserCapture,
} from "../services/ynap-capture-normalizer.server";
import {
  isStoneIslandCapture,
  normalizeStoneIslandCapture,
  parseLocalizedNumber,
} from "../services/stone-island-capture-normalizer.server";
import { storeYnapCapture } from "../services/ynap-catalog-store.server";
import { createStoredAdminClient } from "../services/shopify-stored-admin.server";
import { syncProductToShopifyStrict } from "../services/shopify-sync-fixed.server";
import { skuForVariant } from "../services/sku-policy.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-ParserVo-Token",
  "Cache-Control": "no-store",
};

function response(data: unknown, status = 200) {
  return json(data, { status, headers: corsHeaders });
}

function normalizeCapture(capture: YnapBrowserCapture) {
  return isStoneIslandCapture(capture)
    ? normalizeStoneIslandCapture(capture)
    : normalizeYnapCapture(capture);
}

async function saveImportState(handle: string, patch: Record<string, unknown>) {
  await databaseAdminRequest(
    `parservo_products?handle=eq.${encodeURIComponent(handle)}`,
    {
      method: "PATCH",
      headers: databaseAdminHeaders("return=minimal"),
      body: JSON.stringify({
        ...patch,
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return response({
    ok: true,
    name: "ParserVo NET-A-PORTER / MR PORTER / Stone Island capture API",
    version: "stone-island-2.4.0",
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
      linkId?: string;
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

    const normalized = normalizeCapture(payload.capture);
    if (normalized.product.source === "STONE_ISLAND") {
      normalized.product.variants = normalized.product.variants.map((variant) => ({
        ...variant,
        sku: skuForVariant(normalized.product, variant, false),
      }));
    }

    const stored = await storeYnapCapture(normalized);
    let shopify: any = null;
    let shopifyError: string | null = null;

    try {
      const admin = await createStoredAdminClient(shop);
      const captureWithSettings = payload.capture as YnapBrowserCapture & {
        defaultQuantity?: number | string;
        quantity?: number | string;
      };
      const defaultQuantity = Math.max(
        0,
        Math.trunc(parseLocalizedNumber(captureWithSettings.defaultQuantity ?? captureWithSettings.quantity ?? 5)),
      );
      shopify = await syncProductToShopifyStrict(admin, normalized.product, {
        eurRate: parseLocalizedNumber(payload.capture.rates?.eur) || 55,
        plnRate: parseLocalizedNumber(payload.capture.rates?.pln) || 12.19,
        defaultQuantity,
      });
      const warnings = Array.isArray(shopify?.metafieldErrors)
        ? shopify.metafieldErrors.filter(Boolean)
        : [];
      if (warnings.length) {
        console.warn("ParserVo Shopify field warnings", {
          handle: stored.handle,
          warnings,
        });
      }
      await saveImportState(stored.handle, {
        shopify_product_gid: shopify?.productId || null,
        import_status: "IMPORTED",
        last_error: warnings.length ? `Warnings: ${warnings.join(" | ")}`.slice(0, 4000) : null,
      });
    } catch (error) {
      shopifyError = error instanceof Error ? error.message : String(error);
      console.error("ParserVo Shopify sync failed", {
        handle: stored.handle,
        message: shopifyError,
      });
      await saveImportState(stored.handle, {
        import_status: "ERROR",
        last_error: shopifyError.slice(0, 4000),
      });
    }

    if (payload.linkId && !shopifyError) {
      await markCrawlLinkSuccess({
        linkId: payload.linkId,
        productHandle: stored.handle,
      });
    }

    await recordBrowserHeartbeat({
      shopDomain: shop,
      agentId: String(payload.agentId || "chrome-extension"),
      version: payload.version,
      status: "BUSY",
      message: shopifyError
        ? `Shopify error: ${shopifyError.slice(0, 300)}`
        : `Uploaded ${normalized.product.brand} ${normalized.product.title}`,
      currentJobId: payload.capture.jobId || null,
    });

    if (shopifyError) {
      return response({
        ok: false,
        error: `Shopify import failed: ${shopifyError}`,
        product: {
          handle: stored.handle,
          brand: normalized.product.brand,
          title: normalized.product.title,
        },
      }, 500);
    }

    return response({
      ok: true,
      product: {
        handle: stored.handle,
        brand: normalized.product.brand,
        title: normalized.product.title,
        color: normalized.product.color,
        sizes: normalized.product.sizes,
        price: normalized.product.price,
        compareAtPrice: normalized.product.compareAtPrice,
        currency: normalized.product.currency,
        availableVariants: stored.availableVariants,
        images: stored.images,
        videos: stored.videos,
      },
      shopify,
      shopifyError: null,
    });
  } catch (error) {
    return response({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown capture error",
    }, 500);
  }
}
