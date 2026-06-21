import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";
import { splitMedia } from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type UserError = { field?: string[] | string | null; message: string; code?: string | null };

export type SyncSettings = {
  eurRate: number;
  plnRate: number;
  defaultQuantity: number;
};

export type SyncResult = {
  handle: string;
  productId: string;
  title: string;
  variants: number;
  images: number;
  action: "created_or_updated";
};

function money(value: number | null | undefined) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function productHandle(product: ParsedMarketplaceProduct) {
  const raw = product.handle || product.supplierProductId || product.title;
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

function productTitle(product: ParsedMarketplaceProduct) {
  const brand = String(product.brand || "").trim();
  const title = String(product.title || "").trim();
  return title.toUpperCase().startsWith(brand.toUpperCase()) ? title : `${brand} ${title}`.trim();
}

async function graphql<T>(admin: AdminClient, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (!response.ok) throw new Error(`Shopify API HTTP ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message?: string }) => error.message || "GraphQL error").join(" | "));
  }
  return json.data as T;
}

function throwUserErrors(context: string, errors?: UserError[]) {
  if (!errors?.length) return;
  throw new Error(`${context}: ${errors.map((error) => error.message).join(" | ")}`);
}

async function resolveLocation(admin: AdminClient) {
  const data = await graphql<{ locations: { nodes: Array<{ id: string; name: string; isActive?: boolean }> } }>(
    admin,
    `#graphql
      query ParserVoSyncLocations {
        locations(first: 20) { nodes { id name isActive } }
      }
    `,
    {},
  );
  return data.locations.nodes.find((location) => location.isActive !== false) || data.locations.nodes[0] || null;
}

export function mapSupplierQuantity(rawQuantity: number | null | undefined, available: boolean | null | undefined, fallbackQuantity: number) {
  if (available === false) return 0;
  if (rawQuantity === 0) return 0;
  if (rawQuantity === 1) return 1;
  if (typeof rawQuantity === "number" && rawQuantity > 1) return 5;
  if (available === true) return 5;
  if (fallbackQuantity === 1) return 1;
  if (fallbackQuantity > 1) return 5;
  return 0;
}

function normalizedVariants(product: ParsedMarketplaceProduct, settings: SyncSettings): ParsedMarketplaceVariant[] {
  const rawVariants = product.variants?.length
    ? [...product.variants].sort((a, b) => a.position - b.position)
    : sortSizesForShopify(product.sizes.length ? product.sizes : ["Default Title"]).map((size, index) => ({
        size,
        quantity: settings.defaultQuantity,
        available: settings.defaultQuantity > 0,
        position: index + 1,
      }));

  return rawVariants
    .map((variant) => ({
      ...variant,
      quantity: mapSupplierQuantity(variant.quantity, variant.available, settings.defaultQuantity),
    }))
    .filter((variant) => variant.quantity > 0);
}

export async function syncProductToShopify(admin: AdminClient, product: ParsedMarketplaceProduct, settings: SyncSettings): Promise<SyncResult> {
  const handle = productHandle(product);
  const variants = normalizedVariants(product, settings);
  if (!variants.length) throw new Error(`Товар ${productTitle(product)} пропущен: нет размеров в наличии.`);

  const calculated = calculatePricing({
    supplierPrice: product.price || 0,
    supplierOldPrice: product.compareAtPrice || null,
    currency: product.currency,
    eurRate: settings.eurRate,
    plnRate: settings.plnRate,
    roundingRule: "round_to_5",
    compareAtEnabled: true,
  });

  const baseCost = product.pricing?.costPriceUah ?? calculated.costPriceUah;
  const baseSale = product.pricing?.salePriceUah ?? calculated.salePriceUah;
  const baseCompareAt = product.pricing?.compareAtPriceUah ?? calculated.compareAtPriceUah;
  const defaultVariant = variants.length === 1 && variants[0].size === "Default Title";
  const optionName = defaultVariant ? "Title" : "Size";
  const location = await resolveLocation(admin);
  if (!location) throw new Error("В Shopify не найдена активная локация для остатков.");

  const { images } = splitMedia(product.media);
  const validImages = images.filter((item) => /^https?:\/\//i.test(item.url)).slice(0, 5);
  const files = validImages.map((image, index) => ({
    originalSource: image.url,
    alt: image.alt || `${productTitle(product)} ${index + 1}`,
    contentType: "IMAGE",
  }));

  const descriptionHtml = product.descriptionHtml || [
    product.description ? `<p>${product.description}</p>` : "",
    product.composition ? `<p><strong>Composition:</strong> ${product.composition}</p>` : "",
    product.color ? `<p><strong>Color:</strong> ${product.color}</p>` : "",
  ].filter(Boolean).join("\n");

  const input = {
    title: productTitle(product),
    handle,
    descriptionHtml: `${descriptionHtml}<p><strong>Source:</strong> ${product.sourceUrl}</p>`,
    vendor: product.brand,
    productType: product.productType || product.category,
    status: "DRAFT",
    tags: Array.from(new Set([
      ...(product.tags || []),
      product.source === "NET_A_PORTER" ? "NET-A-PORTER" : "MR PORTER",
      product.gender === "WOMEN" ? "Women" : "Men",
      "Imported by ParserVo",
      "Preorder",
    ])),
    productOptions: [{
      name: optionName,
      position: 1,
      values: variants.map((variant) => ({ name: variant.size })),
    }],
    files,
    variants: variants.map((variant) => {
      const cost = variant.costPriceUah ?? baseCost;
      const sale = variant.salePriceUah ?? baseSale;
      const compareAt = variant.compareAtPriceUah ?? baseCompareAt;
      return {
        optionValues: [{ optionName, name: variant.size }],
        sku: variant.sku || [product.supplierProductId, defaultVariant ? null : variant.size].filter(Boolean).join("-"),
        price: money(sale),
        compareAtPrice: compareAt && compareAt > sale ? money(compareAt) : null,
        inventoryPolicy: "DENY",
        taxable: true,
        inventoryItem: {
          tracked: true,
          requiresShipping: true,
          cost: money(cost),
        },
        inventoryQuantities: [{
          locationId: location.id,
          name: "available",
          quantity: variant.quantity,
        }],
      };
    }),
  };

  const data = await graphql<{
    productSet: {
      product: { id: string; title: string; handle: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoUpsertProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {
        productSet(input: $input, identifier: $identifier, synchronous: $synchronous) {
          product { id title handle }
          userErrors { code field message }
        }
      }
    `,
    {
      input,
      identifier: { handle },
      synchronous: true,
    },
  );

  throwUserErrors("Shopify sync failed", data.productSet.userErrors);
  if (!data.productSet.product) throw new Error("Shopify не вернул созданный или обновлённый товар.");

  return {
    handle,
    productId: data.productSet.product.id,
    title: data.productSet.product.title,
    variants: variants.length,
    images: validImages.length,
    action: "created_or_updated",
  };
}

export async function syncCatalogToShopify(admin: AdminClient, products: ParsedMarketplaceProduct[], settings: SyncSettings) {
  const results: SyncResult[] = [];
  const errors: Array<{ handle: string; message: string }> = [];

  for (const product of products) {
    try {
      results.push(await syncProductToShopify(admin, product, settings));
    } catch (error) {
      errors.push({
        handle: productHandle(product),
        message: error instanceof Error ? error.message : "Unknown sync error",
      });
    }
  }

  return { results, errors, total: products.length, success: results.length, failed: errors.length };
}
