import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  databaseAdminHeaders,
  databaseAdminRequest,
  recordBrowserHeartbeat,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";
import { markCrawlLinkSuccess } from "../services/crawl-link-queue.server";
import { resolveStandardColor } from "../services/color-mappings.server";
import {
  normalizeYnapCapture,
  type NormalizedYnapCapture,
  type YnapBrowserCapture,
} from "../services/ynap-capture-normalizer.server";
import {
  extractStoneIslandProductCode,
  isStoneIslandCapture,
  normalizeStoneIslandCapture,
  parseLocalizedNumber,
} from "../services/stone-island-capture-normalizer.server";
import { storeYnapCapture } from "../services/ynap-catalog-store.server";
import { createStoredAdminClient } from "../services/shopify-stored-admin.server";
import { syncProductToShopifyStrict } from "../services/shopify-sync-fixed.server";
import { syncStoneIslandInventoryOnly } from "../services/shopify-inventory-refresh.server";
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

function slug(value: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function productSlugFromUrl(urlValue: string, productCode: string) {
  try {
    return decodeURIComponent(new URL(urlValue).pathname.split("/").filter(Boolean).pop() || "")
      .replace(/\.html?$/i, "")
      .replace(new RegExp(`-${productCode}$`, "i"), "") || productCode;
  } catch {
    return productCode;
  }
}

function normalizeCapture(capture: YnapBrowserCapture) {
  return isStoneIslandCapture(capture)
    ? normalizeStoneIslandCapture(capture)
    : normalizeYnapCapture(capture);
}

function normalizeStockCapture(capture: YnapBrowserCapture): NormalizedYnapCapture {
  try {
    return normalizeStoneIslandCapture(capture);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/sizes were not captured|all sizes are sold out|нет размеров/i.test(message)) throw error;

    const productCode = extractStoneIslandProductCode(capture);
    const handle = slug(`${productSlugFromUrl(capture.url, productCode)}-${productCode}`);
    return {
      categoryId: capture.categoryId,
      productCode,
      sourcePayload: capture,
      product: {
        handle,
        source: "STONE_ISLAND",
        gender: capture.gender === "WOMEN" ? "WOMEN" : "MEN",
        category: String(capture.category || "Catalog"),
        brand: "Stone Island",
        title: String(capture.title || productCode).trim(),
        sourceUrl: capture.url,
        supplierProductId: productCode,
        price: parseLocalizedNumber(capture.price),
        compareAtPrice: parseLocalizedNumber(capture.compareAtPrice) || null,
        currency: String(capture.currency || "PLN"),
        color: String(capture.color || "").trim() || null,
        sizes: [],
        variants: [],
        pricing: {
          costPriceUah: 0,
          salePriceUah: 0,
          compareAtPriceUah: null,
        },
        tags: ["Stone Island", capture.gender === "WOMEN" ? "Women" : "Men"],
        description: null,
        descriptionHtml: null,
        composition: null,
        media: [],
      },
    };
  }
}

function uniqueTags(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = String(value || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

async function productForShopify(normalized: NormalizedYnapCapture) {
  const product = normalized.product;
  if (product.source !== "STONE_ISLAND") return product;

  const originalColor = String(product.color || "").trim();
  const standardColor = await resolveStandardColor(originalColor);
  if (!standardColor) return product;

  return {
    ...product,
    color: standardColor,
    tags: uniqueTags([
      ...(product.tags || []),
      originalColor && originalColor.toLowerCase() !== standardColor.toLowerCase() ? originalColor : null,
    ]),
  };
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
    version: "stone-island-2.9.9-colors",
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
      capture?: YnapBrowserCapture & { mode?: string };
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

    const stockOnly = String(payload.capture.mode || "").toUpperCase() === "STOCK_ONLY";
    const normalized = stockOnly
      ? normalizeStockCapture(payload.capture)
      : normalizeCapture(payload.capture);

    if (normalized.product.source === "STONE_ISLAND") {
      normalized.product.variants = normalized.product.variants.map((variant) => ({
        ...variant,
        sku: skuForVariant(normalized.product, variant, false),
      }));
    }

    let stored: { handle: string; availableVariants: number; images: number; videos: number };
    let shopify: any = null;
    let shopifyError: string | null = null;

    try {
      const admin = await createStoredAdminClient(shop);
      if (stockOnly) {
        shopify = await syncStoneIslandInventoryOnly(admin, normalized.product);
        stored = {
          handle: String(normalized.product.handle || ""),
          availableVariants: Number(shopify?.inStockVariants || 0),
          images: 0,
          videos: 0,
        };
      } else {
        stored = await storeYnapCapture(normalized);
        const captureWithSettings = payload.capture as YnapBrowserCapture & {
          defaultQuantity?: number | string;
          quantity?: number | string;
        };
        const defaultQuantity = Math.max(
          0,
          Math.trunc(parseLocalizedNumber(captureWithSettings.defaultQuantity ?? captureWithSettings.quantity ?? 5)),
        );
        const mappedProduct = await productForShopify(normalized);
        shopify = await syncProductToShopifyStrict(admin, mappedProduct, {
          eurRate: parseLocalizedNumber(payload.capture.rates?.eur) || 55,
          plnRate: parseLocalizedNumber(payload.capture.rates?.pln) || 12.19,
          defaultQuantity,
        });
      }

      const warnings = Array.isArray(shopify?.metafieldErrors)
        ? shopify.metafieldErrors.filter(Boolean)
        : [];
      await saveImportState(stored.handle, {
        ...(shopify?.productId ? { shopify_product_gid: shopify.productId } : {}),
        import_status: shopify?.totalQuantity === 0 ? "OUT_OF_STOCK" : "IMPORTED",
        last_seen_at: new Date().toISOString(),
        last_error: warnings.length ? `Warnings: ${warnings.join(" | ")}`.slice(0, 4000) : null,
      });
    } catch (error) {
      stored = {
        handle: String(normalized.product.handle || ""),
        availableVariants: 0,
        images: 0,
        videos: 0,
      };
      shopifyError = error instanceof Error ? error.message : String(error);
      console.error("ParserVo Shopify sync failed", {
        handle: stored.handle,
        stockOnly,
        message: shopifyError,
      });
      if (stored.handle) {
        await saveImportState(stored.handle, {
          import_status: "ERROR",
          last_error: shopifyError.slice(0, 4000),
        }).catch(() => {});
      }
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
        : stockOnly
          ? `Inventory updated ${normalized.product.title}`
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
      mode: stockOnly ? "STOCK_ONLY" : "FULL_IMPORT",
      product: {
        handle: stored.handle,
        brand: normalized.product.brand,
        title: normalized.product.title,
        color: normalized.product.color,
        standardColor: shopify?.standardColor || null,
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
