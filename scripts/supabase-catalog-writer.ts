const DEFAULT_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

export type CrawledVariant = {
  size: string;
  quantity: number;
  available: boolean;
  status: string;
  position: number;
  sku?: string | null;
};

export type CrawledMedia = {
  type: "image" | "video";
  url: string;
  position: number;
  alt?: string | null;
};

export type CrawledProduct = {
  handle: string;
  source: "NET_A_PORTER" | "MR_PORTER";
  gender: "WOMEN" | "MEN";
  categoryId: string;
  category: string;
  sourceUrl: string;
  productCode: string;
  title: string;
  brand: string;
  descriptionHtml: string;
  color?: string | null;
  composition?: string | null;
  currency: string;
  supplierPrice: number;
  compareAtPrice?: number | null;
  costPriceUah: number;
  salePriceUah: number;
  compareAtPriceUah?: number | null;
  tags: string[];
  variants: CrawledVariant[];
  media: CrawledMedia[];
  payload?: unknown;
};

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is required for crawler writes.");
  return { url, key };
}

function headers(key: string, prefer?: string) {
  const result: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  if (key.startsWith("eyJ")) result.Authorization = `Bearer ${key}`;
  if (prefer) result.Prefer = prefer;
  return result;
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...headers(key),
      ...((init.headers || {}) as Record<string, string>),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

export async function startCrawlRun(input: {
  categoryId: string;
  source: string;
  pages: number;
}) {
  const rows = await rest("parservo_crawl_runs", {
    method: "POST",
    headers: headers(config().key, "return=representation"),
    body: JSON.stringify([{
      category_id: input.categoryId,
      source: input.source,
      status: "COLLECTING_LINKS",
      pages_total: input.pages,
    }]),
  });
  return rows?.[0]?.id as string;
}

export async function updateCrawlRun(id: string, patch: Record<string, unknown>) {
  await rest(`parservo_crawl_runs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers(config().key, "return=minimal"),
    body: JSON.stringify(patch),
  });
}

export async function upsertProduct(product: CrawledProduct) {
  const now = new Date().toISOString();
  const availableVariants = product.variants.filter((variant) => variant.quantity > 0 && variant.available);

  await rest("parservo_products?on_conflict=handle", {
    method: "POST",
    headers: headers(config().key, "resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify([{
      handle: product.handle,
      source: product.source,
      gender: product.gender,
      category_id: product.categoryId,
      source_url: product.sourceUrl,
      product_code: product.productCode,
      title: product.title,
      description_html: product.descriptionHtml,
      vendor: product.brand,
      product_category: product.category,
      product_type: product.category,
      tags: product.tags,
      status: availableVariants.length ? "active" : "draft",
      supplier_currency: product.currency,
      supplier_price: product.supplierPrice,
      cost_price_uah: product.costPriceUah,
      sale_price_uah: product.salePriceUah,
      compare_at_price_uah: product.compareAtPriceUah || null,
      import_status: availableVariants.length ? "READY" : "OUT_OF_STOCK",
      color: product.color || null,
      composition: product.composition || null,
      last_seen_at: now,
      source_payload: product.payload || null,
      updated_at: now,
    }]),
  });

  await rest(`parservo_variants?product_handle=eq.${encodeURIComponent(product.handle)}`, {
    method: "DELETE",
  });

  if (product.variants.length) {
    await rest("parservo_variants", {
      method: "POST",
      headers: headers(config().key, "return=minimal"),
      body: JSON.stringify(product.variants.map((variant) => ({
        product_handle: product.handle,
        size: variant.size,
        sku: variant.sku || `${product.productCode}-${variant.size}`,
        inventory_qty: variant.quantity,
        price_uah: product.salePriceUah,
        compare_at_price_uah: product.compareAtPriceUah || null,
        cost_uah: product.costPriceUah,
        available: variant.available,
        position: variant.position,
        supplier_status: variant.status,
        last_seen_at: now,
      }))),
    });
  }

  await rest(`parservo_media?product_handle=eq.${encodeURIComponent(product.handle)}`, {
    method: "DELETE",
  });

  if (product.media.length) {
    await rest("parservo_media", {
      method: "POST",
      headers: headers(config().key, "return=minimal"),
      body: JSON.stringify(product.media.map((item) => ({
        product_handle: product.handle,
        media_type: item.type,
        url: item.url,
        position: item.position,
        alt_text: item.alt || product.title,
      }))),
    });
  }
}

export async function markMissingProducts(categoryId: string, seenHandles: string[]) {
  if (!seenHandles.length) return;
  const { key } = config();
  const filter = seenHandles.map((handle) => `"${handle.replace(/"/g, "")}"`).join(",");
  await rest(`parservo_products?category_id=eq.${encodeURIComponent(categoryId)}&handle=not.in.(${encodeURIComponent(filter)})`, {
    method: "PATCH",
    headers: headers(key, "return=minimal"),
    body: JSON.stringify({
      import_status: "NOT_SEEN",
      status: "draft",
      updated_at: new Date().toISOString(),
    }),
  });
}
