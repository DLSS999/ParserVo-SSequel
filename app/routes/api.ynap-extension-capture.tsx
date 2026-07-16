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
import { storeYnapCapture } from "../services/ynap-catalog-store.server";
import { createStoredAdminClient } from "../services/shopify-stored-admin.server";
import { syncProductToShopifyStrict } from "../services/shopify-sync-fixed.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-ParserVo-Token",
  "Cache-Control": "no-store",
};

function response(data: unknown, status = 200) {
  return json(data, { status, headers: corsHeaders });
}

function numericPrice(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "")
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isStoneIslandCapture(capture: YnapBrowserCapture) {
  try {
    const url = new URL(String(capture.url || ""));
    return String(capture.categoryId || "").startsWith("stone-island:") &&
      /(^|\.)stoneisland\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}


function normalizeCapture(capture: YnapBrowserCapture) {
  if (!isStoneIslandCapture(capture)) return normalizeYnapCapture(capture);

  const originalUrl = capture.url;
  const productCode = String(capture.productCode || "stone-island-product")
    .replace(/\.html?$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-");

  const sourceCurrency = String(capture.currency || "PLN").toUpperCase();
  const sourcePrice = numericPrice(capture.price);
  const sourceCompareAtPrice = numericPrice(capture.compareAtPrice) || null;
  const plnRate = numericPrice(capture.rates?.pln) || 12.19;
  const eurRate = numericPrice(capture.rates?.eur) || 55;

  const conversionFactor = sourceCurrency === "PLN" ? plnRate / eurRate : 1;
  const strictPrice = sourcePrice * conversionFactor;
  const strictCompareAtPrice = sourceCompareAtPrice
    ? sourceCompareAtPrice * conversionFactor
    : null;

  const compatibleCapture = {
    ...capture,
    categoryId: "mrp-clothing",
    source: "MR_PORTER",
    gender: "MEN",
    category: capture.category || "Clothing",
    brand: capture.brand || "STONE ISLAND",
    productCode,
    currency: sourceCurrency === "PLN" ? "EUR" : sourceCurrency,
    price: strictPrice,
    compareAtPrice: strictCompareAtPrice,
    url: `https://www.mrporter.com/en-pl/mens/product/stone-island/clothing/${productCode}/${productCode}`,
    media: (capture.media || []).map((item, index) => ({
      ...item,
      originalUrl: item.type === "video"
        ? `https://www.mrporter.com/variants/videos/${productCode}/${index + 1}.mp4`
        : `https://www.mrporter.com/variants/images/${productCode}/${index + 1}.jpg`,
    })),
  } as YnapBrowserCapture;

  const normalized = normalizeYnapCapture(compatibleCapture);
  normalized.categoryId = capture.categoryId;
  normalized.sourcePayload = capture;
  normalized.product.sourceUrl = originalUrl;
  normalized.product.source = "STONE_ISLAND" as any;
  normalized.product.brand = "STONE ISLAND";
  normalized.product.vendor = "STONE ISLAND" as any;
  normalized.product.category = capture.category || "Clothing";
  normalized.product.productType = capture.category || "Clothing";
  normalized.product.tags = ["Men", "STONE ISLAND", "Stone Island Poland"];
  normalized.product.price = sourcePrice;
  normalized.product.compareAtPrice = sourceCompareAtPrice;
  normalized.product.currency = sourceCurrency;

  return normalized;
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
    const stored = await storeYnapCapture(normalized);
    let shopify: any = null;
    let shopifyError: string | null = null;

    try {
      const admin = await createStoredAdminClient(shop);
      shopify = await syncProductToShopifyStrict(admin, normalized.product, {
        eurRate: Number(payload.capture.rates?.eur || 55),
        plnRate: Number(payload.capture.rates?.pln || 12.19),
        defaultQuantity: 5,
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
