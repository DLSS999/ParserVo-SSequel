import type {
  ParsedMarketplaceProduct,
  ParsedMarketplaceVariant,
  SourceMediaItem,
} from "./media.server";
import { calculatePricing } from "./pricing.server";
import {
  cleanSupplierDescription,
  getProductMapping,
} from "./product-mapping.server";
import { browserCategories } from "./ynap-browser-config.server";

export type CapturedSize = {
  text?: string;
  size?: string;
  disabled?: boolean;
  available?: boolean;
  quantity?: number | null;
  status?: string;
};

export type CapturedMedia = {
  url?: string;
  alt?: string;
  type?: "image" | "video";
  originalUrl?: string;
  contentType?: string;
  byteLength?: number;
};

export type YnapBrowserCapture = {
  jobId?: string;
  categoryId: string;
  source: "NET_A_PORTER" | "MR_PORTER";
  gender: "WOMEN" | "MEN";
  category: string;
  url: string;
  title: string;
  brand: string;
  description?: string;
  descriptionHtml?: string;
  color?: string;
  composition?: string;
  productCode?: string;
  currency?: string;
  price?: number | string;
  compareAtPrice?: number | string | null;
  productAvailable?: boolean;
  sizes?: CapturedSize[];
  media?: CapturedMedia[];
  rates?: {
    eur?: number | string;
    pln?: number | string;
  };
};

export type NormalizedYnapCapture = {
  product: ParsedMarketplaceProduct;
  categoryId: string;
  productCode: string;
  sourcePayload: YnapBrowserCapture;
};

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "")
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function brandKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function normalizeTitle(title: string, brand: string) {
  const clean = String(title || "")
    .replace(/\s*\|\s*(NET-A-PORTER|MR PORTER).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return brand && clean.toUpperCase().startsWith(brand.toUpperCase())
    ? clean
    : `${brand} ${clean}`.trim();
}

function normalizeSize(value: string) {
  const clean = String(value || "")
    .replace(/^size\s*:?\s*/i, "")
    .replace(/\s*[-–—:]\s*(sold out|low stock|only \d+ left|last one|unavailable|out of stock).*$/i, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();

  const map: Array<[RegExp, string]> = [
    [/^(XXXSMALL|3XS)$/i, "XXXS"],
    [/^(XXSMALL|2XS)$/i, "XXS"],
    [/^(XSMALL|XS)$/i, "XS"],
    [/^(SMALL|S)$/i, "S"],
    [/^(MEDIUM|M)$/i, "M"],
    [/^(LARGE|L)$/i, "L"],
    [/^(XLARGE|XL)$/i, "XL"],
    [/^(XXLARGE|2XL|XXL)$/i, "2XL"],
    [/^(XXXLARGE|3XL|XXXL)$/i, "3XL"],
    [/^(ONESIZE|OS)$/i, "ONE SIZE"],
  ];

  for (const [pattern, normalized] of map) {
    if (pattern.test(clean)) return normalized;
  }
  if (/^(IT|EU|FR|UK|US)\d{1,3}(?:\.5)?$/.test(clean)) return clean;
  if (/^\d{1,3}(?:\.5)?$/.test(clean)) return clean;
  if (/^[A-Z]{1,5}$/.test(clean)) return clean;
  return null;
}

function mappedQuantity(size: CapturedSize) {
  const status = `${size.text || ""} ${size.status || ""}`;
  if (size.disabled || size.available === false || /sold out|unavailable|out of stock/i.test(status)) return 0;
  if (size.quantity === 1 || /low stock|only\s*1|last one/i.test(status)) return 1;
  if (typeof size.quantity === "number" && size.quantity <= 0) return 0;
  return 5;
}

function normalizeVariants(
  capture: YnapBrowserCapture,
  productCode: string,
  pricing: ReturnType<typeof calculatePricing>,
) {
  const bySize = new Map<string, ParsedMarketplaceVariant>();
  for (const item of capture.sizes || []) {
    const size = normalizeSize(String(item.size || item.text || ""));
    if (!size) continue;
    const quantity = mappedQuantity(item);
    bySize.set(size, {
      size,
      quantity,
      available: quantity > 0,
      position: bySize.size + 1,
      sku: `${productCode}-${size.replace(/\s+/g, "-")}`,
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    });
  }

  if (!bySize.size && capture.productAvailable !== false) {
    bySize.set("ONE SIZE", {
      size: "ONE SIZE",
      quantity: 5,
      available: true,
      position: 1,
      sku: `${productCode}-OS`,
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    });
  }

  return [...bySize.values()].map((variant, index) => ({
    ...variant,
    position: index + 1,
  }));
}

function exactSourceMedia(row: CapturedMedia, productCode: string) {
  const source = String(row.originalUrl || row.url || "");
  let decoded = source;
  try { decoded = decodeURIComponent(source); } catch { /* keep source */ }
  if (row.type === "video") {
    return decoded.includes(`/variants/videos/${productCode}/`);
  }
  return decoded.includes(`/variants/images/${productCode}/`);
}

function normalizeMedia(rows: CapturedMedia[], productCode: string) {
  const seen = new Set<string>();
  const all: SourceMediaItem[] = [];

  for (const row of rows || []) {
    const url = String(row.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    if (!exactSourceMedia(row, productCode)) continue;
    if (row.type !== "video" && Number(row.byteLength || 0) > 0 && Number(row.byteLength) < 5000) continue;
    if (/teads|doubleclick|tracking|analytics|\/content\/images\/cms\//i.test(String(row.originalUrl || ""))) continue;
    seen.add(url);
    all.push({
      type: row.type === "video" ? "video" : "image",
      url,
      position: all.length + 1,
      alt: row.alt || null,
    });
  }

  const images = all.filter((item) => item.type === "image").slice(0, 5);
  const video = all.find((item) => item.type === "video");
  if (!images.length) {
    throw new Error(`No exact product images were captured for ${productCode}.`);
  }
  return [
    ...images.map((item, index) => ({ ...item, position: index + 1 })),
    ...(video ? [{ ...video, position: images.length + 1 }] : []),
  ];
}

function cleanComposition(value: unknown) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (!clean || /sale|promotion|discount|order|delivery|net-a-porter|mr porter/i.test(clean)) return "";
  return clean;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exactDescriptionHtml(value: string) {
  const clean = cleanSupplierDescription(value);
  if (!clean) return null;
  return clean
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
}

export function normalizeYnapCapture(capture: YnapBrowserCapture): NormalizedYnapCapture {
  const config = browserCategories.find((category) => category.id === capture.categoryId);
  if (!config) throw new Error(`Unknown category: ${capture.categoryId}`);

  const sourceUrl = new URL(capture.url);
  if (!/(net-a-porter\.com|mrporter\.com)$/i.test(sourceUrl.hostname)) {
    throw new Error("Invalid NET-A-PORTER / MR PORTER URL.");
  }
  if (capture.source !== config.source || capture.gender !== config.gender) {
    throw new Error("Captured source does not match the queued category.");
  }

  const brand = String(capture.brand || "").trim();
  if (!config.brands.some((allowed) => brandKey(allowed) === brandKey(brand))) {
    throw new Error(`Brand outside configured filter: ${brand || "empty"}`);
  }

  if (typeof capture.price === "string" && /delivery|shipping|orders?|free standard|% off/i.test(capture.price)) {
    throw new Error("Rejected promotional text instead of the product price.");
  }
  const supplierPrice = numberValue(capture.price);
  if (!supplierPrice || supplierPrice > 2000) {
    throw new Error(`Price outside configured range: ${supplierPrice}`);
  }

  const compareAtPrice = numberValue(capture.compareAtPrice) || null;
  const currency = String(capture.currency || "EUR").toUpperCase();
  const pricing = calculatePricing({
    supplierPrice,
    supplierOldPrice: compareAtPrice,
    currency,
    eurRate: numberValue(capture.rates?.eur) || 55,
    plnRate: numberValue(capture.rates?.pln) || 12.19,
    compareAtEnabled: true,
  });

  const productCode = String(
    capture.productCode || sourceUrl.pathname.split("/").filter(Boolean).pop() || slug(capture.title),
  );
  const pathParts = sourceUrl.pathname.split("/").filter(Boolean);
  const productSlug = pathParts[pathParts.length - 2] || capture.title;
  const handle = slug(`${productSlug}-${productCode}`);
  const title = normalizeTitle(capture.title, brand);
  const variants = normalizeVariants(capture, productCode, pricing);
  const media = normalizeMedia(capture.media || [], productCode);
  const description = cleanSupplierDescription(capture.descriptionHtml || capture.description);

  const product: ParsedMarketplaceProduct = {
    handle,
    source: capture.source,
    gender: capture.gender,
    category: capture.category,
    productType: capture.category,
    brand,
    title,
    sourceUrl: capture.url,
    supplierProductId: productCode,
    price: supplierPrice,
    compareAtPrice,
    currency,
    color: String(capture.color || "").trim() || null,
    sizes: variants.map((variant) => variant.size),
    variants,
    pricing: {
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    },
    tags: [capture.gender === "WOMEN" ? "Women" : "Men", brand],
    description: description || null,
    descriptionHtml: exactDescriptionHtml(description),
    composition: cleanComposition(capture.composition) || null,
    media,
  };

  const mapping = getProductMapping(product);
  product.productType = mapping.productType;
  product.productCategory = mapping.taxonomyPath;

  return {
    product,
    categoryId: capture.categoryId,
    productCode,
    sourcePayload: capture,
  };
}
