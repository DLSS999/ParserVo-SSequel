import { buildShopifyImportDraft } from "./shopify-import-legacy.server";
import { type ParsedMarketplaceProduct } from "./media.server";

export type ImportSettings = {
  eurRate: number;
  plnRate: number;
  defaultQuantity: number;
};

function getConfig() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shop || !token) {
    throw new Error("Vercel ENV missing: SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN");
  }
  return { shop, token };
}

function isImageUrl(url: string) {
  return String(url || "").startsWith("http://") || String(url || "").startsWith("https://");
}

async function api(path: string, method: string, body?: unknown) {
  const cfg = getConfig();
  const url = "https://" + cfg.shop + "/admin/api/2024-10" + path;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": cfg.token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data.errors || data));
  return data;
}

export async function importParsedProductToShopify(product: ParsedMarketplaceProduct, settings: ImportSettings) {
  const draft = buildShopifyImportDraft(product, settings);
  const images = draft.media
    .filter((m) => m.type === "IMAGE" && isImageUrl(m.url))
    .slice(0, 5)
    .map((m) => ({ src: m.url, alt: m.alt || draft.title }));

  const payload = {
    product: {
      title: draft.title,
      body_html: draft.descriptionHtml,
      vendor: draft.vendor,
      product_type: draft.productType,
      status: "draft",
      tags: draft.tags.join(", "),
      options: [{ name: draft.variants[0]?.optionName || "Size" }],
      variants: draft.variants.map((v) => ({
        option1: v.optionValue,
        sku: v.sku,
        price: v.price,
        compare_at_price: v.compareAtPrice || undefined,
        inventory_management: "shopify",
        inventory_policy: "deny",
        inventory_quantity: settings.defaultQuantity,
      })),
      images,
    },
  };

  const result = await api("/products.json", "POST", payload);
  return result.product;
}

export async function updateProductInventory(productId: string | number, quantity: number) {
  const data = await api("/products/" + productId + ".json", "GET");
  const variants = data.product?.variants || [];
  for (const variant of variants) {
    await api("/variants/" + variant.id + ".json", "PUT", {
      variant: { id: variant.id, inventory_quantity: quantity },
    });
  }
  return { productId, updatedVariants: variants.length, quantity };
}
