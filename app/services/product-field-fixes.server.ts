import type { ParsedMarketplaceProduct } from "./media.server";
import { getProductMapping } from "./product-mapping.server";

const SHOPIFY_STANDARD_COLOR_TAGS = new Set([
  "silver",
  "red",
  "purple",
  "pink",
  "green",
  "gray",
  "blue",
  "black",
  "beige",
  "brown",
  "navy",
  "white",
  "bronze",
  "clear",
  "gold",
  "orange",
  "rose gold",
  "yellow",
]);

function cleanSupplierColor(value: string | null | undefined) {
  return String(value || "")
    .replace(/^colou?r\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nonStandardColorTag(product: ParsedMarketplaceProduct) {
  const color = cleanSupplierColor(product.color);
  if (!color || color.length > 60) return "";

  const normalized = color.toLowerCase();
  if (SHOPIFY_STANDARD_COLOR_TAGS.has(normalized)) return "";
  if (/^\d+\s+colou?rs?$/i.test(color)) return "";
  if (/^(?:select|choose)\s+(?:a\s+)?colou?r$/i.test(color)) return "";

  return color;
}

function uniqueTags(values: string[]) {
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

export function getCorrectProductMapping(product: ParsedMarketplaceProduct) {
  const source = ` ${[
    product.title,
    product.description,
    product.descriptionHtml,
    product.composition,
    product.productType,
    product.productCategory,
    product.category,
    product.sourceUrl,
  ].filter(Boolean).join(" ")} `.toLowerCase();

  // Stone Island frequently omits the garment class from the visible title.
  // Use the supplier description before the broad source category so a
  // crewneck sweatshirt is not incorrectly classified as a hoodie.
  if (/\b(?:crewneck|crew neck|sweatshirts?)\b|світшот/.test(source)
      && !/\b(?:hoodie|hooded|zip[-\s]?hoodie)\b|худі/.test(source)) {
    return {
      kind: "sweatshirt" as const,
      productType: "Світшоти",
      nameType: "Світшот",
      taxonomyPath: "Apparel & Accessories > Clothing > Activewear > Activewear Sweatshirts & Hoodies > Sweatshirts",
    };
  }

  if (/\b(capris?|cropped trousers?|cropped pants?)\b|капрі/.test(source)) {
    return {
      kind: "trousers" as const,
      productType: "Брюки",
      nameType: "Брюки",
      taxonomyPath: "Apparel & Accessories > Clothing > Pants > Trousers",
    };
  }

  return getProductMapping(product);
}

export function cleanPublicDescription(value: string | null | undefined) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\bShop\s+.+?\s+on\s+(?:MR PORTER|NET[- ]A[- ]PORTER)\b[.!]?/gi, "")
    .replace(/\bExplore the latest[^.!]*[.!]?/gi, "")
    .replace(/\bPromotion\s*:[\s\S]*$/gi, "")
    .replace(/\bSale now[\s\S]*$/gi, "")
    .replace(/\bT&Cs apply[.!]?/gi, "")
    .replace(/\bEnjoy\s+\d+%[^.!]*[.!]?/gi, "")
    .replace(/\bfirst order[^.!]*[.!]?/gi, "")
    .replace(/\bShop now[.!]?/gi, "")
    .replace(/\b(?:NET[- ]A[- ]PORTER|MR PORTER)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function publicProductTags(product: ParsedMarketplaceProduct, productType: string) {
  const hidden = /net-a-porter|mr\s*porter|imported\s+by\s+parservo|parservo/i;
  return uniqueTags([
    ...(product.tags || []).filter((tag) => !hidden.test(String(tag))),
    product.gender === "WOMEN" ? "Women" : "Men",
    productType,
    nonStandardColorTag(product),
    "Preorder",
  ]);
}
