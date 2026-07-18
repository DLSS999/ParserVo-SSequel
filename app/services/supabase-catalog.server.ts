import type { ParsedMarketplaceProduct } from "./media.server";

const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

type ProductRow = {
  handle: string;
  source: "NET_A_PORTER" | "MR_PORTER" | "STONE_ISLAND";
  gender: "WOMEN" | "MEN";
  source_url: string;
  product_code?: string | null;
  title: string;
  description_html?: string | null;
  vendor: string;
  product_category?: string | null;
  product_type?: string | null;
  tags?: string[] | null;
  status?: string | null;
  supplier_currency: string;
  supplier_price?: number | string | null;
  cost_price_uah?: number | string | null;
  sale_price_uah?: number | string | null;
  compare_at_price_uah?: number | string | null;
  shopify_product_gid?: string | null;
  import_status?: string | null;
  last_error?: string | null;
  last_seen_at?: string | null;
  updated_at?: string | null;
  color?: string | null;
  composition?: string | null;
  parservo_variants?: Array<{
    size: string;
    sku?: string | null;
    inventory_qty?: number | null;
    price_uah?: number | string | null;
    compare_at_price_uah?: number | string | null;
    cost_uah?: number | string | null;
    available?: boolean | null;
    position?: number | null;
    supplier_status?: string | null;
  }>;
  parservo_media?: Array<{
    media_type: "image" | "video";
    url: string;
    position?: number | null;
    alt_text?: string | null;
  }>;
};

function numberOrNull(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type SupabaseCatalogResult = {
  products: ParsedMarketplaceProduct[];
  connected: boolean;
  error: string | null;
};

export async function loadSupabaseCatalog(): Promise<SupabaseCatalogResult> {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!key) {
    return {
      products: [],
      connected: false,
      error: "Supabase API key is not configured.",
    };
  }

  const select = "*,parservo_variants(*),parservo_media(*)";
  const endpoint = `${url}/rest/v1/parservo_products?select=${encodeURIComponent(select)}&order=created_at.asc`;
  const requestHeaders: Record<string, string> = {
    apikey: key,
    Accept: "application/json",
  };
  if (key.startsWith("eyJ")) requestHeaders.Authorization = `Bearer ${key}`;

  try {
    const response = await fetch(endpoint, {
      headers: requestHeaders,
      cache: "no-store",
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 500)}`);
    }

    const rows = JSON.parse(body) as ProductRow[];
    const products = rows.map((row): ParsedMarketplaceProduct => {
      const variants = [...(row.parservo_variants || [])]
        .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
        .map((variant, index) => ({
          size: variant.size,
          sku: variant.sku || null,
          quantity: Number(variant.inventory_qty || 0),
          available: variant.available !== false && Number(variant.inventory_qty || 0) > 0,
          position: Number(variant.position || index + 1),
          costPriceUah: numberOrNull(variant.cost_uah),
          salePriceUah: numberOrNull(variant.price_uah),
          compareAtPriceUah: numberOrNull(variant.compare_at_price_uah),
        }));

      const media = [...(row.parservo_media || [])]
        .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
        .map((item, index) => ({
          type: item.media_type,
          url: item.url,
          position: Number(item.position || index + 1),
          alt: item.alt_text || null,
        }));

      return {
        handle: row.handle,
        source: row.source,
        gender: row.gender,
        category: row.product_type || row.product_category || "Other",
        productCategory: row.product_category || null,
        productType: row.product_type || null,
        brand: row.vendor,
        title: row.title,
        sourceUrl: row.source_url,
        supplierProductId: row.product_code || row.handle,
        price: numberOrNull(row.supplier_price),
        currency: row.supplier_currency || "UAH",
        color: row.color || null,
        sizes: variants.map((variant) => variant.size),
        variants,
        pricing: {
          costPriceUah: numberOrNull(row.cost_price_uah) || 0,
          salePriceUah: numberOrNull(row.sale_price_uah) || 0,
          compareAtPriceUah: numberOrNull(row.compare_at_price_uah),
        },
        tags: row.tags || [],
        status: row.status || "draft",
        descriptionHtml: row.description_html || null,
        composition: row.composition || null,
        media,
        shopifyProductGid: row.shopify_product_gid || null,
        importStatus: row.import_status || null,
        lastError: row.last_error || null,
        lastSeenAt: row.last_seen_at || null,
        updatedAt: row.updated_at || null,
      };
    });

    return { products, connected: true, error: null };
  } catch (error) {
    return {
      products: [],
      connected: false,
      error: error instanceof Error ? error.message : "Supabase catalog error",
    };
  }
}
