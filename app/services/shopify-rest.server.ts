import { type ParsedMarketplaceProduct, splitMedia } from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";

export type ImportSettings = {
  eurRate: number;
  plnRate: number;
  defaultQuantity: number;
};

function getConfig() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shop || !token) throw new Error("Vercel ENV missing: SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN");
  return { shop, token };
}

function money(value: number | null | undefined) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "0.00";
}

function isImageUrl(url: string) {
  return String(url || "").startsWith("http://") || String(url || "").startsWith("https://");
}

async function api(path: string, method: string, body?: unknown) {
  const cfg = getConfig();
  const url = "https://" + cfg.shop + "/admin/api/2024-10" + path;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": cfg.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data.errors || data));
  return data;
}

export async function importParsedProductToShopify(product: ParsedMarketplaceProduct, settings: ImportSettings) {
  const pricing = calculatePricing({ supplierPrice: product.price || 0, supplierOldPrice: product.compareAtPrice || null, currency: product.currency, eurRate: settings.eurRate, plnRate: settings.plnRate, roundingRule: "round_to_5", compareAtEnabled: true });
  const sizes = sortSizesForShopify(product.sizes.length ? product.sizes : ["Default Title"]);
  const media = splitMedia(product.media);
  const images = media.images.filter((m) => isImageUrl(m.url)).slice(0, 5).map((m) => ({ src: m.url, alt: product.title }));
  const payload = {
    product: {
      title: `${product.brand} ${product.title}`.trim(),
      body_html: [product.description, product.composition, product.sourceUrl].filter(Boolean).join("<br>"),
      vendor: product.brand,
      product_type: product.category,
      status: "draft",
      tags: [product.source, product.gender, product.brand, product.category, "Imported by ParserVo"].join(", "),
      options: [{ name: sizes.length === 1 && sizes[0] === "Default Title" ? "Title" : "Size" }],
      variants: sizes.map((size) => ({
        option1: size,
        sku: [product.supplierProductId, size].filter(Boolean).join("-"),
        price: money(pricing.salePriceUah),
        compare_at_price: pricing.compareAtPriceUah ? money(pricing.compareAtPriceUah) : undefined,
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
    await api("/variants/" + variant.id + ".json", "PUT", { variant: { id: variant.id, inventory_quantity: quantity } });
  }
  return { productId, updatedVariants: variants.length, quantity };
}
