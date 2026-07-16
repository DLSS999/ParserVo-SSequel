import type { ParsedMarketplaceProduct } from "./media.server";
import { getProductMapping } from "./product-mapping.server";

export function getCorrectProductMapping(product: ParsedMarketplaceProduct) {
  const source = ` ${[
    product.title,
    product.productType,
    product.productCategory,
    product.category,
    product.sourceUrl,
  ].filter(Boolean).join(" ")} `.toLowerCase();

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
  return Array.from(new Set([
    ...(product.tags || []).filter((tag) => !hidden.test(String(tag))),
    product.gender === "WOMEN" ? "Women" : "Men",
    productType,
    "Preorder",
  ].map((tag) => String(tag || "").trim()).filter(Boolean)));
}
