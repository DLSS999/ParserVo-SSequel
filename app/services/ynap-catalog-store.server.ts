import type { NormalizedYnapCapture } from "./ynap-capture-normalizer.server";
import {
  databaseAdminHeaders,
  databaseAdminRequest,
} from "./browser-capture.server";

export async function storeYnapCapture(normalized: NormalizedYnapCapture) {
  const { product, categoryId, productCode, sourcePayload } = normalized;
  const handle = String(product.handle || "");
  if (!handle) throw new Error("Normalized product handle is empty.");

  const now = new Date().toISOString();
  const variants = product.variants || [];
  const hasAvailableVariant = variants.some((variant) => variant.available && variant.quantity > 0);

  await databaseAdminRequest("parservo_products?on_conflict=handle", {
    method: "POST",
    headers: databaseAdminHeaders("resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify([{
      handle,
      source: product.source,
      gender: product.gender,
      category_id: categoryId,
      source_url: product.sourceUrl,
      product_code: productCode,
      title: product.title,
      description_html: product.descriptionHtml || (product.description ? `<p>${product.description}</p>` : ""),
      vendor: product.brand,
      product_category: product.productCategory || product.category,
      product_type: product.productType || product.category,
      tags: product.tags || [],
      status: hasAvailableVariant ? "active" : "draft",
      supplier_currency: product.currency,
      supplier_price: product.price || 0,
      cost_price_uah: product.pricing?.costPriceUah || 0,
      sale_price_uah: product.pricing?.salePriceUah || 0,
      compare_at_price_uah: product.pricing?.compareAtPriceUah || null,
      import_status: hasAvailableVariant ? "READY" : "OUT_OF_STOCK",
      color: product.color || null,
      composition: product.composition || null,
      last_seen_at: now,
      source_payload: sourcePayload,
      updated_at: now,
    }]),
  });

  await databaseAdminRequest(`parservo_variants?product_handle=eq.${encodeURIComponent(handle)}`, {
    method: "DELETE",
  });

  if (variants.length) {
    await databaseAdminRequest("parservo_variants", {
      method: "POST",
      headers: databaseAdminHeaders("return=minimal"),
      body: JSON.stringify(variants.map((variant) => ({
        product_handle: handle,
        size: variant.size,
        sku: variant.sku || `${productCode}-${variant.size}`,
        inventory_qty: variant.quantity,
        price_uah: variant.salePriceUah ?? product.pricing?.salePriceUah ?? 0,
        compare_at_price_uah: variant.compareAtPriceUah ?? product.pricing?.compareAtPriceUah ?? null,
        cost_uah: variant.costPriceUah ?? product.pricing?.costPriceUah ?? 0,
        available: variant.available,
        position: variant.position,
        supplier_status: variant.quantity === 0
          ? "SOLD_OUT"
          : variant.quantity === 1
            ? "LOW_STOCK"
            : "IN_STOCK",
        last_seen_at: now,
      }))),
    });
  }

  await databaseAdminRequest(`parservo_media?product_handle=eq.${encodeURIComponent(handle)}`, {
    method: "DELETE",
  });

  if (product.media.length) {
    await databaseAdminRequest("parservo_media", {
      method: "POST",
      headers: databaseAdminHeaders("return=minimal"),
      body: JSON.stringify(product.media.map((item) => ({
        product_handle: handle,
        media_type: item.type,
        url: item.url,
        position: item.position,
        alt_text: item.alt || product.title,
      }))),
    });
  }

  return {
    handle,
    availableVariants: variants.filter((variant) => variant.available && variant.quantity > 0).length,
    images: product.media.filter((item) => item.type === "image").length,
    videos: product.media.filter((item) => item.type === "video").length,
  };
}
