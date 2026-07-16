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

function productSlug(value: string | null | undefined) {
  try {
    const lastSegment = decodeURIComponent(
      new URL(String(value || "")).pathname.split("/").filter(Boolean).pop() || "",
    );
    return lastSegment
      .replace(/\.html?$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

type ProductMapping = ReturnType<typeof getProductMapping>;

function customExactMapping(facts: string): ProductMapping | null {
  const value = ` ${facts.toLowerCase()} `;

  if (/\bbooks?\b|\bmonographs?\b|\blookbooks?\b|книг/.test(value)) {
    return {
      kind: "other",
      productType: "Книги",
      nameType: "Книга",
      taxonomyPath: "Media > Books",
    };
  }

  if (/\bgloves?\b|рукавич/.test(value)) {
    return {
      kind: "other",
      productType: "Рукавички",
      nameType: "Рукавички",
      taxonomyPath: "Apparel & Accessories > Clothing Accessories > Gloves & Mittens",
    };
  }

  if (/\bkey\s*(?:chains?|rings?)\b|\bkeychains?\b|брелок/.test(value)) {
    return {
      kind: "other",
      productType: "Брелоки",
      nameType: "Брелок",
      taxonomyPath: "Apparel & Accessories > Clothing Accessories",
    };
  }

  return null;
}

function normalizeExactFacts(value: string) {
  let normalized = String(value || "").toLowerCase();

  // Product names used by Stone Island that are more specific than the broad
  // navigation sections but are not present in the legacy classifier.
  normalized = normalized
    .replace(/\bovershirts?\b/g, " shirt ")
    .replace(/\bparkas?\b|\btrench(?:\s+coats?)?\b|\bpea\s*coats?\b/g, " coat ")
    .replace(/\bblousons?\b|\bwindbreakers?\b|\banoraks?\b|\bfield\s+jackets?\b/g, " jacket ")
    .replace(/\bjumpers?\b/g, " sweater ")
    .replace(/\bjoggers?\b|\bcargo\s+pants?\b/g, " trousers ")
    .replace(/\bbermudas?\b/g, " shorts ")
    .replace(/\bgilets?\b/g, " vest ");

  // A bare fleece product without a more precise garment word belongs to the
  // fleece/sweatshirt family. More precise words such as jacket or hoodie win.
  if (/\bfleece(?:wear)?\b/.test(normalized)
      && !/\b(?:jackets?|coats?|hoodies?|shirts?|overshirts?|vests?|trousers?|pants?|shorts?)\b/.test(normalized)) {
    normalized += " sweatshirt ";
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function exactProductMapping(product: ParsedMarketplaceProduct, facts: string): ProductMapping | null {
  const cleanFacts = normalizeExactFacts(facts);
  if (!cleanFacts) return null;

  const custom = customExactMapping(cleanFacts);
  if (custom) return custom;

  const mapping = getProductMapping({
    ...product,
    title: cleanFacts,
    category: "",
    productType: "",
    productCategory: "",
    sourceUrl: "",
  });

  return mapping.kind === "other" ? null : mapping;
}

export function getCorrectProductMapping(product: ParsedMarketplaceProduct) {
  // 1. The concrete product identity always has the highest priority. The last
  // URL segment contains the actual Stone Island product slug, without broad
  // category names such as polos-and-t-shirts or trousers-and-shorts.
  const identityFacts = [
    product.title,
    productSlug(product.sourceUrl),
  ].filter(Boolean).join(" ");
  const identityMapping = exactProductMapping(product, identityFacts);
  if (identityMapping) return identityMapping;

  // 2. Use the concrete product description and composition. This resolves
  // products whose visible title contains only an article and fabric name.
  const detailFacts = [
    product.description,
    product.descriptionHtml,
    product.composition,
  ].filter(Boolean).join(" ");
  const detailMapping = exactProductMapping(product, detailFacts);
  if (detailMapping) return detailMapping;

  // 3. Only when the product itself has no identifiable type may the broad
  // Stone Island navigation category be used as a fallback.
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
