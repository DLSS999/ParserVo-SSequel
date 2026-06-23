import type {
  ParsedMarketplaceProduct,
  ParsedMarketplaceVariant,
  SourceMediaItem,
} from "./media.server";
import { calculatePricing } from "./pricing.server";
import {
  buildDescriptionHtml,
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
    .replace(/^size\s*/i, "")
    .replace(/\s*[-–—:]\s*(sold out|low stock|only \d+ left|last one|unavailable|out of stock).*$/i, "")
    .replace(/^(EU|UK|US)\s+/i, "")
    .trim();

  const map: Array<[RegExp, string]> = [
    [/^(xxx\s*small|3xs)$/i, "XXXS"],
    [/^(xx\s*small|2xs)$/i, "XXS"],
    [/^(x\s*small|xs)$/i, "XS"],
    [/^(small|s)$/i, "S"],
    [/^(medium|m)$/i, "M"],
    [/^(large|l)$/i, "L"],
    [/^(x\s*large|xl)$/i, "XL"],
    [/^(xx\s*large|2xl|xxl)$/i, "2XL"],
    [/^(xxx\s*large|3xl|xxxl)$/i, "3XL"],
    [/^(one\s*size|os)$/i, "ONE SIZE"],
  ];

  for (const [pattern, normalized] of map) {
    if (pattern.test(clean)) return normalized;
  }

  if (/^\d{1,3}(?:\.5)?$/.test(clean)) return clean;
  if (/^[A-Z]{1,5}$/.test(clean.toUpperCase())) return clean.toUpperCase();
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
      sku: `${productCode}-${size}`,
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

function normalizeMedia(rows: CapturedMedia[]) {
  const seen = new Set<string>();
  const all: SourceMediaItem[] = [];

  for (const row of rows || []) {
    const url = String(row.url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    if (/logo|icon|sprite|flag|newsletter/i.test(url)) continue;
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
  return [
    ...images,
    ...(video ? [{ ...video, position: images.length + 1 }] : []),
  ];
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
    eurRate: numberValue(capture.rates?.eur) || 45,
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
  const media = normalizeMedia(capture.media || []);
  const cleanedDescription = cleanSupplierDescription(capture.descriptionHtml || capture.description);

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
    color: capture.color || null,
    sizes: variants.map((variant) => variant.size),
    variants,
    pricing: {
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    },
    tags: [
      capture.source === "NET_A_PORTER" ? "NET-A-PORTER" : "MR PORTER",
      capture.gender === "WOMEN" ? "Women" : "Men",
      capture.category,
      brand,
      "Imported by ParserVo",
    ],
    description: cleanedDescription || null,
    descriptionHtml: null,
    composition: capture.composition || null,
    media,
  };

  const mapping = getProductMapping(product);
  product.productType = mapping.productType;
  product.productCategory = mapping.taxonomyPath;
  product.descriptionHtml = buildDescriptionHtml(product);

  return {
    product,
    categoryId: capture.categoryId,
    productCode,
    sourcePayload: capture,
  };
}
