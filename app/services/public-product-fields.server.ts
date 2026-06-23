import type { ParsedMarketplaceProduct } from "./media.server";

export function publicProductTags(product: ParsedMarketplaceProduct, productType: string) {
  const hidden = /net-a-porter|mr\s*porter|imported\s+by\s+parservo|parservo/i;
  return Array.from(new Set([
    ...(product.tags || []).filter((tag) => !hidden.test(String(tag))),
    product.gender === "WOMEN" ? "Women" : "Men",
    productType,
    "Preorder",
  ].map((tag) => String(tag || "").trim()).filter(Boolean)));
}
