import type {
  ParsedMarketplaceProduct,
  ParsedMarketplaceVariant,
  SourceMediaItem,
} from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";
import {
  cleanSupplierDescription,
  getProductMapping,
} from "./product-mapping.server";
import type {
  CapturedMedia,
  CapturedSize,
  NormalizedYnapCapture,
  YnapBrowserCapture,
} from "./ynap-capture-normalizer.server";

const STONE_HOST = /(^|\.)stoneisland\.com$/i;
const STONE_MEDIA_HOST = /(^|\.)thron\.com$/i;
const GENERIC_CODE_WORDS = new Set([
  "COMPLIMENTARY",
  "STANDARD",
  "SHIPPING",
  "DELIVERY",
  "COLLECTIONS",
  "PRODUCT",
  "STONEISLAND",
]);

export function parseLocalizedNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const source = String(value ?? "").replace(/\u00a0/g, " ").trim();
  const match = source.match(/-?[0-9][0-9\s.,]*/);
  if (!match) return 0;

  let raw = match[0].replace(/\s/g, "");
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    raw = raw.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0) {
    const decimals = raw.length - comma - 1;
    raw = decimals === 2 ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (dot >= 0) {
    const decimals = raw.length - dot - 1;
    if (decimals !== 2) raw = raw.replace(/\./g, "");
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
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

function cleanText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanColor(value: unknown) {
  const clean = cleanText(value)
    .replace(/^colou?r\s*:\s*/i, "")
    .replace(/\s+(?:size|fit|find my size)\s*:?.*$/i, "")
    .trim();
  if (!clean || /^\d+\s+colou?rs?$/i.test(clean) || clean.length > 60) return "";
  if (/^(select|choose)\s+(?:a\s+)?colou?r$/i.test(clean)) return "";
  return clean;
}

export function extractStoneIslandProductCode(capture: Pick<YnapBrowserCapture, "url" | "productCode" | "title">) {
  let path = "";
  try {
    path = decodeURIComponent(new URL(capture.url).pathname);
  } catch {
    path = String(capture.url || "");
  }

  const fromPath = path.match(/(?:^|[-/])(L[A-Z0-9]{12,})(?:\.html?)?$/i)?.[1]
    || path.match(/\b(L[A-Z0-9]{12,})\b/i)?.[1];
  if (fromPath) return fromPath.toUpperCase();

  const supplied = cleanText(capture.productCode).replace(/\.html?$/i, "");
  if (/^L[A-Z0-9]{12,}$/i.test(supplied)) return supplied.toUpperCase();
  if (/^[A-Z0-9][A-Z0-9._-]{5,}$/i.test(supplied) && !GENERIC_CODE_WORDS.has(supplied.toUpperCase())) {
    return supplied.toUpperCase();
  }

  const titleCode = cleanText(capture.title).match(/\b\d{7}\b/)?.[0];
  if (titleCode) return titleCode;
  throw new Error("Stone Island product code was not found in the product URL.");
}

function productSlugFromUrl(urlValue: string, productCode: string) {
  try {
    const file = decodeURIComponent(new URL(urlValue).pathname.split("/").filter(Boolean).pop() || "")
      .replace(/\.html?$/i, "")
      .replace(new RegExp(`-${productCode}$`, "i"), "");
    return file || productCode;
  } catch {
    return productCode;
  }
}

function cleanTitle(value: unknown) {
  const clean = cleanText(value)
    .replace(/\s*\|\s*Stone Island.*$/i, "")
    .replace(/^STONE ISLAND\s+/i, "");
  return clean;
}

function exactStoneIslandColor(capture: YnapBrowserCapture) {
  const direct = cleanColor(capture.color);
  if (direct) return direct;

  const body = String(capture.bodyText || "");
  const match = body.match(/COLOU?R\s*:\s*([^\n]+?)(?=\s+(?:SIZE|FIT|FIND MY SIZE)\s*:|$)/i);
  const fromBody = cleanColor(match?.[1]);
  if (fromBody) return fromBody;

  const code = extractStoneIslandProductCode(capture).replace(/[^a-z0-9]/gi, "");
  for (const item of capture.media || []) {
    const alt = cleanText(item.alt);
    if (!alt) continue;
    const beforeCode = code ? alt.split(new RegExp(code, "i"))[0] : alt;
    const candidate = cleanColor(beforeCode);
    if (candidate && !/^(image|product|stone island)$/i.test(candidate)) return candidate;
  }
  return "";
}

function stoneIslandPrices(capture: YnapBrowserCapture) {
  let price = parseLocalizedNumber(capture.price);
  let compareAtPrice = parseLocalizedNumber(capture.compareAtPrice) || null;
  const source = `${String(capture.pageHtml || "")}\n${String(capture.bodyText || "")}`;
  const pair = source.match(
    /Original price\s*(?:zł|PLN|€|EUR|£|GBP|\$|USD)?\s*([\d\s.,]+)\s*,?\s*current price\s*(?:zł|PLN|€|EUR|£|GBP|\$|USD)?\s*([\d\s.,]+)/i,
  );
  if (pair) {
    const oldValue = parseLocalizedNumber(pair[1]);
    const saleValue = parseLocalizedNumber(pair[2]);
    if (saleValue > 0) price = saleValue;
    if (oldValue > saleValue) compareAtPrice = oldValue;
  }
  if (!price || price <= 0 || price > 100_000) {
    throw new Error(`Stone Island product price is invalid: ${price || 0}`);
  }
  if (compareAtPrice && compareAtPrice <= price) compareAtPrice = null;
  return { price, compareAtPrice };
}

function normalizeSize(value: unknown) {
  const clean = cleanText(value)
    .replace(/^size\s*:?\s*/i, "")
    .replace(/\s*[-–—:]\s*(sold out|low stock|only \d+ left|last one|unavailable|out of stock).*$/i, "")
    .replace(/\s+/g, "")
    .toUpperCase();

  const aliases: Array<[RegExp, string]> = [
    [/^(XXXSMALL|3XS)$/i, "XXXS"],
    [/^(XXSMALL|2XS)$/i, "XXS"],
    [/^(XSMALL|XS)$/i, "XS"],
    [/^(SMALL|S)$/i, "S"],
    [/^(MEDIUM|M)$/i, "M"],
    [/^(LARGE|L)$/i, "L"],
    [/^(XLARGE|XL)$/i, "XL"],
    [/^(XXLARGE|2XL|XXL)$/i, "XXL"],
    [/^(XXXLARGE|3XL|XXXL)$/i, "XXXL"],
    [/^(ONESIZE|OS)$/i, "ONE SIZE"],
  ];
  for (const [pattern, result] of aliases) if (pattern.test(clean)) return result;
  if (/^(IT|EU|FR|UK|US)\d{1,3}(?:\.5)?$/.test(clean)) return clean;
  if (/^\d{1,3}(?:\.5)?$/.test(clean)) return clean;
  return "";
}

function configuredQuantity(capture: YnapBrowserCapture) {
  const raw = parseLocalizedNumber(capture.defaultQuantity ?? capture.quantity ?? 5);
  return Math.max(0, Math.min(999, Math.trunc(raw || 0)));
}

function sizeQuantity(size: CapturedSize, fallback: number) {
  const status = `${size.text || ""} ${size.status || ""}`;
  if (size.disabled || size.available === false || /sold out|unavailable|out of stock/i.test(status)) return 0;
  if (typeof size.quantity === "number" && Number.isFinite(size.quantity)) {
    return Math.max(0, Math.trunc(size.quantity));
  }
  if (/low stock|only\s*1|last one/i.test(status)) return 1;
  return fallback;
}

function buildVariants(
  capture: YnapBrowserCapture,
  productCode: string,
  pricing: ReturnType<typeof calculatePricing>,
  allowOneSize: boolean,
) {
  const fallbackQuantity = configuredQuantity(capture);
  const bySize = new Map<string, ParsedMarketplaceVariant>();

  for (const row of capture.sizes || []) {
    const size = normalizeSize(row.size || row.text);
    if (!size) continue;
    const quantity = sizeQuantity(row, fallbackQuantity);
    if (quantity <= 0) continue;
    bySize.set(size, {
      size,
      quantity,
      available: true,
      position: bySize.size + 1,
      sku: `${productCode}-${size.replace(/\s+/g, "-")}`,
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    });
  }

  if (!bySize.size && allowOneSize && capture.productAvailable !== false && fallbackQuantity > 0) {
    bySize.set("ONE SIZE", {
      size: "ONE SIZE",
      quantity: fallbackQuantity,
      available: true,
      position: 1,
      sku: `${productCode}-OS`,
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    });
  }

  const sorted = sortSizesForShopify([...bySize.keys()]);
  return sorted.map((size, index) => ({ ...bySize.get(size)!, position: index + 1 }));
}

function stoneMediaMatchesProduct(urlValue: string, productCode: string) {
  try {
    const url = new URL(urlValue);
    if (!STONE_MEDIA_HOST.test(url.hostname)) return false;
    if (!url.pathname.toLowerCase().includes("/delivery/public/image/stoneisland/")) return false;
    const compactPath = decodeURIComponent(url.pathname).replace(/[^a-z0-9]/gi, "").toUpperCase();
    const compactCode = productCode.replace(/[^a-z0-9]/gi, "").toUpperCase();
    return compactCode.length >= 7 && compactPath.includes(compactCode);
  } catch {
    return false;
  }
}

function normalizeMedia(rows: CapturedMedia[], productCode: string, title: string) {
  const seen = new Set<string>();
  const images: SourceMediaItem[] = [];
  for (const row of rows || []) {
    if (row.type === "video") continue;
    const url = cleanText(row.url || row.originalUrl);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    if (!stoneMediaMatchesProduct(url, productCode)) continue;
    if (/logo|icon|sprite|flag|payment/i.test(url)) continue;
    seen.add(url);
    images.push({
      type: "image",
      url,
      position: images.length + 1,
      alt: cleanText(row.alt) || `${title} ${images.length + 1}`,
    });
    if (images.length >= 5) break;
  }
  if (!images.length) throw new Error(`No exact Stone Island product images were captured for ${productCode}.`);
  return images;
}

function inferCategory(urlValue: string, fallback: string) {
  try {
    const parts = new URL(urlValue).pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part.toLowerCase() === "collection");
    const raw = index >= 0 ? parts[index + 1] : "";
    if (raw) return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    // Use fallback.
  }
  return cleanText(fallback) || "Clothing";
}

function descriptionHtml(value: string) {
  const clean = cleanSupplierDescription(value);
  if (!clean) return null;
  const escaped = clean
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<p>${escaped}</p>`;
}

export function isStoneIslandCapture(capture: YnapBrowserCapture) {
  try {
    const url = new URL(String(capture.url || ""));
    const categoryId = String(capture.categoryId || "");
    return (categoryId === "stone-island" || categoryId.startsWith("stone-island:"))
      && STONE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeStoneIslandCapture(capture: YnapBrowserCapture): NormalizedYnapCapture {
  if (!isStoneIslandCapture(capture)) throw new Error("Invalid Stone Island capture payload.");

  const productCode = extractStoneIslandProductCode(capture);
  const title = cleanTitle(capture.title);
  if (!title) throw new Error("Stone Island product title is empty.");

  const brand = "Stone Island";
  const color = exactStoneIslandColor(capture);
  if (!color) throw new Error("Stone Island product color was not captured.");

  const currency = cleanText(capture.currency || "PLN").toUpperCase();
  if (!/^(PLN|EUR|GBP|USD)$/.test(currency)) throw new Error(`Unsupported Stone Island currency: ${currency}`);
  const prices = stoneIslandPrices(capture);
  const pricing = calculatePricing({
    supplierPrice: prices.price,
    supplierOldPrice: prices.compareAtPrice,
    currency,
    eurRate: parseLocalizedNumber(capture.rates?.eur) || 55,
    plnRate: parseLocalizedNumber(capture.rates?.pln) || 12.19,
    compareAtEnabled: true,
  });

  const category = inferCategory(capture.url, capture.category);
  const provisional: ParsedMarketplaceProduct = {
    handle: slug(`${productSlugFromUrl(capture.url, productCode)}-${productCode}`),
    source: "STONE_ISLAND",
    gender: capture.gender === "WOMEN" ? "WOMEN" : "MEN",
    category,
    brand,
    title,
    sourceUrl: capture.url,
    supplierProductId: productCode,
    price: prices.price,
    compareAtPrice: prices.compareAtPrice,
    currency,
    color,
    sizes: [],
    variants: [],
    pricing: {
      costPriceUah: pricing.costPriceUah,
      salePriceUah: pricing.salePriceUah,
      compareAtPriceUah: pricing.compareAtPriceUah,
    },
    tags: [capture.gender === "WOMEN" ? "Women" : "Men", brand],
    description: cleanSupplierDescription(capture.descriptionHtml || capture.description) || null,
    descriptionHtml: descriptionHtml(capture.descriptionHtml || capture.description || ""),
    composition: cleanText(capture.composition) || null,
    media: [],
  };

  const mapping = getProductMapping(provisional);
  const oneSizeKinds = new Set([
    "backpack", "shopper", "shoulder_bag", "bag", "belt", "scarf", "cap", "hat", "wallet", "sunglasses",
  ]);
  const variants = buildVariants(capture, productCode, pricing, oneSizeKinds.has(mapping.kind));
  if (!variants.length) {
    throw new Error("Stone Island sizes were not captured or all sizes are sold out. Reload Chrome Capture and run the import again.");
  }

  provisional.sizes = variants.map((variant) => variant.size);
  provisional.variants = variants;
  provisional.media = normalizeMedia(capture.media || [], productCode, title);
  provisional.productType = mapping.productType;
  provisional.productCategory = mapping.taxonomyPath;

  return {
    product: provisional,
    categoryId: capture.categoryId,
    productCode,
    sourcePayload: capture,
  };
}
