import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { calculatePricing } from "../services/pricing.server";
import { parseVitkacProductFromHtml } from "../services/vitkac.server";
import { unauthenticated } from "../shopify.server";
import { syncShopifyInventoryForProduct } from "../services/shopify-products.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-ParserVo-Token, Authorization, Access-Control-Request-Private-Network",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function normalizeBaseNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;

  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.-]/g, "");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

const ALPHA_SIZE_ORDER = ["XXXXS", "XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];

function sizeSortKey(value: string) {
  const normalized = normalizeString(value).replace(",", ".").toUpperCase();
  const numeric = Number(normalized.replace(/[^0-9.]/g, ""));

  if (/^\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(numeric)) {
    return { group: 1, rank: numeric, label: normalized };
  }

  const alphaRank = ALPHA_SIZE_ORDER.indexOf(normalized);
  if (alphaRank >= 0) return { group: 2, rank: alphaRank, label: normalized };

  return { group: 3, rank: 9999, label: normalized };
}

function compareSizes(a: string, b: string) {
  const left = sizeSortKey(a);
  const right = sizeSortKey(b);

  if (left.group !== right.group) return left.group - right.group;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.label.localeCompare(right.label, "uk");
}

function sortVariants<T extends { size: string; supplierSizeLabel?: string | null }>(variants: T[]) {
  return [...variants].sort((a, b) => compareSizes(a.size || a.supplierSizeLabel || "", b.size || b.supplierSizeLabel || ""));
}

function availableSizesFromVariants(variants: Array<{ available: boolean; size: string; supplierSizeLabel?: string | null }>) {
  return sortVariants(variants).filter((variant) => variant.available).map((variant) => variant.size);
}

async function updateExistingProductFromCapture(args: {
  shop: string;
  existingProductId: string;
  parsedProduct: Awaited<ReturnType<typeof parseVitkacProductFromHtml>>;
  pricing: ReturnType<typeof calculatePricing>;
  markupPercent: number;
  settings: {
    defaultShopifyLocationId?: string | null;
    automaticSyncEnabled?: boolean;
    autoDraftSoldOut?: boolean;
    autoActivateAvailable?: boolean;
  };
}) {
  const { shop, existingProductId, parsedProduct, pricing, markupPercent, settings } = args;

  const existingProduct = await db.importedProduct.findFirst({
    where: { id: existingProductId, shop },
    include: { variants: true },
  });

  if (!existingProduct) {
    throw new Error("Existing product not found while updating stock.");
  }

  const previousAvailableSizes = availableSizesFromVariants(existingProduct.variants);

  for (const variant of existingProduct.variants) {
    await db.importedVariant.update({
      where: { id: variant.id },
      data: {
        lastAvailable: variant.available,
        available: false,
      },
    });
  }

  for (const parsedVariant of sortVariants(parsedProduct.variants)) {
    const matchedVariant = existingProduct.variants.find((variant: any) =>
      variant.size === parsedVariant.size ||
      variant.supplierSizeLabel === parsedVariant.supplierSizeLabel ||
      variant.supplierSizeLabel === parsedVariant.size,
    );

    if (matchedVariant) {
      await db.importedVariant.update({
        where: { id: matchedVariant.id },
        data: {
          lastAvailable: matchedVariant.available,
          available: parsedVariant.available,
          supplierSizeLabel: parsedVariant.supplierSizeLabel,
          price: pricing.salePriceUah,
          compareAtPrice: pricing.compareAtPriceUah || 0,
        },
      });
    } else {
      await db.importedVariant.create({
        data: {
          importedProductId: existingProduct.id,
          size: parsedVariant.size,
          supplierSizeLabel: parsedVariant.supplierSizeLabel,
          available: parsedVariant.available,
          lastAvailable: false,
          sku: `${parsedProduct.supplierSymbol || parsedProduct.supplierProductId}-${parsedVariant.size}`,
          price: pricing.salePriceUah,
          compareAtPrice: pricing.compareAtPriceUah || 0,
        },
      });
    }
  }

  const refreshedVariants = await db.importedVariant.findMany({ where: { importedProductId: existingProduct.id } });
  const newAvailableSizes = availableSizesFromVariants(refreshedVariants);
  const stockSourceStatus = newAvailableSizes.length > 0 ? "supplier_available" : "supplier_sold_out";

  await db.importedProduct.update({
    where: { id: existingProduct.id },
    data: {
      supplierCurrency: parsedProduct.supplierCurrency,
      exchangeRateUsed: pricing.exchangeRateUsed,
      supplierPrice: parsedProduct.supplierPrice,
      supplierOldPrice: parsedProduct.supplierOldPrice,
      supplierSymbol: parsedProduct.supplierSymbol || existingProduct.supplierSymbol,
      brand: parsedProduct.brand,
      title: parsedProduct.title,
      originalTitle: parsedProduct.originalTitle,
      description: parsedProduct.description,
      originalDescription: parsedProduct.originalDescription,
      color: parsedProduct.color,
      colorUa: parsedProduct.colorUa,
      gender: parsedProduct.gender,
      genderUa: parsedProduct.genderUa,
      category: parsedProduct.category,
      categoryUa: parsedProduct.categoryUa,
      productType: parsedProduct.productType,
      material: parsedProduct.material,
      composition: parsedProduct.composition,
      countryOfOrigin: parsedProduct.countryOfOrigin || existingProduct.countryOfOrigin,
      modelCode: parsedProduct.modelCode || parsedProduct.supplierSymbol || existingProduct.modelCode,
      breadcrumbs: parsedProduct.breadcrumbs,
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah || 0,
      markupPercent,
      imageUrl: parsedProduct.images[0] || existingProduct.imageUrl,
      imagesJson: JSON.stringify(parsedProduct.images.length > 0 ? parsedProduct.images : JSON.parse(existingProduct.imagesJson || "[]")),
      stockSourceStatus,
      lastSyncedAt: new Date(),
      status: stockSourceStatus === "supplier_available" ? existingProduct.status : "drafted_by_sync",
    },
  });

  let shopifyInventorySync = "skipped";
  let shopifyInventoryMessage = "Automatic Shopify inventory sync is disabled or product is not linked.";

  if (settings.automaticSyncEnabled && existingProduct.syncEnabled && existingProduct.shopifyProductGid) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const result = await syncShopifyInventoryForProduct(admin, existingProduct.id, shop, {
        locationId: settings.defaultShopifyLocationId || null,
        autoDraftSoldOut: settings.autoDraftSoldOut ?? true,
        autoActivateAvailable: settings.autoActivateAvailable ?? true,
      });
      shopifyInventorySync = result.skipped ? "skipped" : "synced";
      shopifyInventoryMessage = result.skipped ? result.reason || "Skipped" : "Shopify inventory synced automatically.";
    } catch (error) {
      shopifyInventorySync = "error";
      shopifyInventoryMessage = error instanceof Error ? error.message : String(error);
    }
  }

  await db.syncLog.create({
    data: {
      shop,
      importedProductId: existingProduct.id,
      supplierName: parsedProduct.supplierName,
      supplierUrl: parsedProduct.supplierUrl,
      status: "stock_browser_refreshed",
      message: `Browser stock refreshed. Available sizes: ${newAvailableSizes.join(", ") || "none"}. Shopify: ${shopifyInventorySync}`,
      oldAvailableSizes: previousAvailableSizes.join(", "),
      newAvailableSizes: newAvailableSizes.join(", "),
      errorMessage: shopifyInventorySync === "error" ? shopifyInventoryMessage : null,
    },
  });

  return {
    previousAvailableSizes,
    newAvailableSizes,
    stockSourceStatus,
    shopifyInventorySync,
    shopifyInventoryMessage,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return jsonResponse({
    ok: true,
    name: "ParserVo Vitkac Capture API",
    message: "POST Vitkac HTML from the Chrome extension to save or refresh a product.",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const rawBody = await request.text();
    const payload = JSON.parse(rawBody || "{}") as {
      shop?: string;
      token?: string;
      url?: string;
      html?: string;
      rates?: {
        pln?: number | string;
        eur?: number | string;
      };
    };

    const shop = normalizeString(payload.shop).toLowerCase();
    const token = normalizeString(payload.token);
    const supplierUrl = normalizeString(payload.url);
    const pageHtml = normalizeString(payload.html);

    if (!shop || !token) {
      return jsonResponse({ ok: false, error: "Missing shop or browser capture token." }, 400);
    }

    if (!supplierUrl || !supplierUrl.includes("vitkac.com")) {
      return jsonResponse({ ok: false, error: "Missing or invalid Vitkac product URL." }, 400);
    }

    if (!pageHtml || pageHtml.length < 1000) {
      return jsonResponse({ ok: false, error: "Missing Vitkac page HTML. Open product page in Chrome and capture again." }, 400);
    }

    const settings = await db.appSettings.findUnique({ where: { shop } });

    if (!settings || !settings.browserCaptureToken || settings.browserCaptureToken !== token) {
      return jsonResponse({ ok: false, error: "Invalid browser capture token for this shop." }, 401);
    }

    const parsedProduct = await parseVitkacProductFromHtml(supplierUrl, pageHtml);

    const plnRate = normalizeBaseNumber(payload.rates?.pln, settings.currencyRatePlnUah);
    const eurRate = normalizeBaseNumber(payload.rates?.eur, settings.currencyRateEurUah);

    const pricing = calculatePricing({
      supplierPrice: parsedProduct.supplierPrice,
      currency: parsedProduct.supplierCurrency,
      eurRate,
      plnRate,
      markupPercent: settings.defaultMarkupPercent,
      roundingRule: settings.roundingRule,
      compareAtEnabled: settings.compareAtEnabled,
      compareAtFormula: settings.compareAtFormula,
    });

    const duplicate = await db.importedProduct.findFirst({
      where: {
        shop,
        OR: [
          { supplierUrl: parsedProduct.supplierUrl },
          { supplierProductId: parsedProduct.supplierProductId },
        ],
      },
      include: { variants: true },
    });

    if (duplicate) {
      const stockUpdate = await updateExistingProductFromCapture({
        shop,
        existingProductId: duplicate.id,
        parsedProduct,
        pricing,
        markupPercent: settings.defaultMarkupPercent,
        settings,
      });

      await db.importQueueItem.updateMany({
        where: { shop, supplierUrl: parsedProduct.supplierUrl },
        data: {
          status: "duplicate",
          note: `Already imported and stock refreshed: ${duplicate.title}`,
          importedProductId: duplicate.id,
        },
      });

      return jsonResponse({
        ok: true,
        duplicate: true,
        stockUpdated: true,
        status: "stock_refreshed",
        message: "Product already exists. Stock was refreshed from browser capture.",
        product: {
          id: duplicate.id,
          title: duplicate.title,
          brand: duplicate.brand,
          supplierProductId: duplicate.supplierProductId,
          status: stockUpdate.stockSourceStatus,
          availableSizes: stockUpdate.newAvailableSizes,
          previousAvailableSizes: stockUpdate.previousAvailableSizes,
          shopifyInventorySync: stockUpdate.shopifyInventorySync,
          shopifyInventoryMessage: stockUpdate.shopifyInventoryMessage,
        },
      });
    }

    const availableSizes = sortVariants(parsedProduct.variants).filter((variant: any) => variant.available).map((variant: any) => variant.size);
    const stockSourceStatus = availableSizes.length > 0 ? "supplier_available" : "supplier_sold_out";

    const createdProduct = await db.importedProduct.create({
      data: {
        shop,
        supplierName: parsedProduct.supplierName,
        supplierUrl: parsedProduct.supplierUrl,
        supplierProductId: parsedProduct.supplierProductId,
        supplierSymbol: parsedProduct.supplierSymbol || "",
        supplierCurrency: parsedProduct.supplierCurrency,
        exchangeRateUsed: pricing.exchangeRateUsed,
        supplierPrice: parsedProduct.supplierPrice,
        supplierOldPrice: parsedProduct.supplierOldPrice,

        brand: parsedProduct.brand,
        title: parsedProduct.title,
        originalTitle: parsedProduct.originalTitle,
        description: parsedProduct.description,
        originalDescription: parsedProduct.originalDescription,

        color: parsedProduct.color,
        colorUa: parsedProduct.colorUa,
        gender: parsedProduct.gender,
        genderUa: parsedProduct.genderUa,
        category: parsedProduct.category,
        categoryUa: parsedProduct.categoryUa,
        productType: parsedProduct.productType,
        material: parsedProduct.material,
        composition: parsedProduct.composition,
        countryOfOrigin: parsedProduct.countryOfOrigin || "",
        modelCode: parsedProduct.modelCode || parsedProduct.supplierSymbol || "",
        breadcrumbs: parsedProduct.breadcrumbs,

        costPriceUah: pricing.costPriceUah,
        salePriceUah: pricing.salePriceUah,
        compareAtPriceUah: pricing.compareAtPriceUah || 0,
        markupPercent: settings.defaultMarkupPercent,

        imageUrl: parsedProduct.images[0] || "",
        imagesJson: JSON.stringify(parsedProduct.images),

        status: "imported",
        stockSourceStatus,
        syncEnabled: true,
      },
    });

    await db.importedVariant.createMany({
      data: sortVariants(parsedProduct.variants).map((variant: any) => ({
        importedProductId: createdProduct.id,
        size: variant.size,
        supplierSizeLabel: variant.supplierSizeLabel,
        available: variant.available,
        lastAvailable: variant.available,
        sku: `${parsedProduct.supplierSymbol || parsedProduct.supplierProductId}-${variant.size}`,
        price: pricing.salePriceUah,
        compareAtPrice: pricing.compareAtPriceUah || 0,
      })),
    });

    await db.importQueueItem.updateMany({
      where: { shop, supplierUrl: parsedProduct.supplierUrl },
      data: {
        status: "imported",
        note: "Captured by Chrome extension.",
        importedProductId: createdProduct.id,
      },
    });

    await db.syncLog.create({
      data: {
        shop,
        importedProductId: createdProduct.id,
        supplierName: parsedProduct.supplierName,
        supplierUrl: parsedProduct.supplierUrl,
        status: "browser_captured",
        message: `Product captured from browser extension. Available sizes: ${availableSizes.join(", ") || "none"}`,
        newAvailableSizes: availableSizes.join(", "),
      },
    });

    return jsonResponse({
      ok: true,
      duplicate: false,
      status: "created",
      message: "Product captured and saved into Imported Products.",
      product: {
        id: createdProduct.id,
        brand: parsedProduct.brand,
        title: parsedProduct.title,
        supplierProductId: parsedProduct.supplierProductId,
        supplierPrice: parsedProduct.supplierPrice,
        supplierCurrency: parsedProduct.supplierCurrency,
        costPriceUah: pricing.costPriceUah,
        salePriceUah: pricing.salePriceUah,
        compareAtPriceUah: pricing.compareAtPriceUah,
        availableSizes,
        imagesCount: parsedProduct.images.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
