import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";

export function skuForVariant(
  product: ParsedMarketplaceProduct,
  variant: ParsedMarketplaceVariant,
  defaultVariant: boolean,
) {
  const supplierCode = String(product.supplierProductId || "").trim();

  // Stone Island uses one style/colour SKU for every size variant.
  // Size belongs only in the Shopify option, never in Variant SKU.
  if (product.source === "STONE_ISLAND" && supplierCode) return supplierCode;

  return String(
    variant.sku
      || [supplierCode, defaultVariant ? null : variant.size].filter(Boolean).join("-"),
  ).trim();
}
