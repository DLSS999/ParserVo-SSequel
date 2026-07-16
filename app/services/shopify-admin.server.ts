import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";
import { splitMedia } from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type UserError = { field?: string[] | string | null; message: string; code?: string | null };

export type ImportSettings = {
  eurRate: number;
  plnRate: number;
  defaultQuantity: number;
};

export class ShopifyImportError extends Error {
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ShopifyImportError";
    this.details = details;
  }
}

async function graphql<T>(admin: AdminClient, query: string, variables: Record<string, unknown> = {}) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (!response.ok) throw new ShopifyImportError(`Shopify API HTTP ${response.status}`, json);
  if (json.errors?.length) {
    throw new ShopifyImportError(json.errors.map((error: { message?: string }) => error.message || "GraphQL error").join(" | "), json.errors);
  }
  return json.data as T;
}

function throwUserErrors(context: string, errors?: UserError[]) {
  if (!errors?.length) return;
  throw new ShopifyImportError(`${context}: ${errors.map((error) => error.message).join(" | ")}`, errors);
}

function money(value: number | null | undefined) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function productTitle(product: ParsedMarketplaceProduct) {
  const brand = String(product.brand || "").trim();
  const title = String(product.title || "").trim();
  return title.toUpperCase().startsWith(brand.toUpperCase()) ? title : `${brand} ${title}`.trim();
}

function toProductGid(value: string) {
  const clean = value.trim();
  if (clean.startsWith("gid://shopify/Product/")) return clean;
  if (/^\d+$/.test(clean)) return `gid://shopify/Product/${clean}`;
  throw new ShopifyImportError("Shopify Product ID must be numeric or gid://shopify/Product/...");
}

async function resolveLocation(admin: AdminClient) {
  try {
    const data = await graphql<{ locations: { nodes: Array<{ id: string; name: string; isActive?: boolean }> } }>(
      admin,
      `#graphql
        query ParserVoLocations {
          locations(first: 10) {
            nodes { id name isActive }
          }
        }
      `,
    );
    return data.locations.nodes.find((location) => location.isActive !== false) || data.locations.nodes[0] || null;
  } catch {
    return null;
  }
}

function buildVariants(product: ParsedMarketplaceProduct, defaultQuantity: number): ParsedMarketplaceVariant[] {
  if (product.variants?.length) {
    return [...product.variants]
      .filter((variant) => variant.available !== false)
      .sort((a, b) => a.position - b.position);
  }

  const sizes = sortSizesForShopify(product.sizes.length ? product.sizes : ["Default Title"]);
  return sizes.map((size, index) => ({
    size,
    quantity: defaultQuantity,
    available: true,
    position: index + 1,
  }));
}

export async function createShopifyProduct(
  admin: AdminClient,
  product: ParsedMarketplaceProduct,
  settings: ImportSettings,
) {
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
  const variants = buildVariants(product, settings.defaultQuantity);
  if (!variants.length) throw new ShopifyImportError("У товара нет доступных размеров.");

  const defaultVariant = variants.length === 1 && variants[0].size === "Default Title";
  const optionName = defaultVariant ? "Title" : "Size";
  const location = await resolveLocation(admin);
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
    ...(product.handle ? { handle: product.handle } : {}),
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
      const quantity = Math.max(0, Math.trunc(variant.quantity ?? settings.defaultQuantity));

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
        ...(location ? {
          inventoryQuantities: [{
            locationId: location.id,
            name: "available",
            quantity,
          }],
        } : {}),
      };
    }),
  };

  const data = await graphql<{
    productSet: {
      product: {
        id: string;
        title: string;
        handle: string;
        status: string;
        media: { nodes: Array<{ id: string; status: string; mediaContentType: string }> };
        variants: { nodes: Array<{ id: string; title: string; sku?: string | null; inventoryItem?: { id: string } | null }> };
      } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoCreateProduct($productSet: ProductSetInput!, $synchronous: Boolean!) {
        productSet(synchronous: $synchronous, input: $productSet) {
          product {
            id
            title
            handle
            status
            media(first: 10) { nodes { id status mediaContentType } }
            variants(first: 250) { nodes { id title sku inventoryItem { id } } }
          }
          userErrors { code field message }
        }
      }
    `,
    { productSet: input, synchronous: true },
  );

  throwUserErrors("Shopify product upload failed", data.productSet.userErrors);
  if (!data.productSet.product?.id) throw new ShopifyImportError("Shopify did not return a product ID.", data);

  return {
    ...data.productSet.product,
    locationName: location?.name || null,
    uploadedImages: validImages.length,
    uploadedVideos: 0,
  };
}

async function activateInventory(admin: AdminClient, inventoryItemId: string, locationId: string, quantity: number) {
  const data = await graphql<{
    inventoryActivate: { inventoryLevel: { id: string } | null; userErrors: UserError[] };
  }>(
    admin,
    `#graphql
      mutation ParserVoInventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
          inventoryLevel { id }
          userErrors { code field message }
        }
      }
    `,
    { inventoryItemId, locationId, available: quantity },
  );
  const blocking = data.inventoryActivate.userErrors.filter((error) => !/already|stocked/i.test(error.message));
  throwUserErrors("Inventory activation failed", blocking);
}

export async function setProductQuantity(admin: AdminClient, productId: string, quantity: number) {
  const productGid = toProductGid(productId);
  const location = await resolveLocation(admin);
  if (!location) throw new ShopifyImportError("Shopify location was not found. Grant read_locations and write_inventory scopes.");

  const productData = await graphql<{
    product: { id: string; variants: { nodes: Array<{ id: string; inventoryItem: { id: string } | null }> } } | null;
  }>(
    admin,
    `#graphql
      query ParserVoProductInventory($id: ID!) {
        product(id: $id) {
          id
          variants(first: 250) { nodes { id inventoryItem { id } } }
        }
      }
    `,
    { id: productGid },
  );
  if (!productData.product) throw new ShopifyImportError("Shopify product was not found.");

  const inventoryItems = productData.product.variants.nodes
    .map((variant) => variant.inventoryItem?.id)
    .filter((id): id is string => Boolean(id));
  const safeQuantity = Math.max(0, Math.trunc(quantity));

  for (const inventoryItemId of inventoryItems) {
    await activateInventory(admin, inventoryItemId, location.id, safeQuantity);
  }

  const data = await graphql<{
    inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: string } | null; userErrors: UserError[] };
  }>(
    admin,
    `#graphql
      mutation ParserVoSetQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { createdAt }
          userErrors { code field message }
        }
      }
    `,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: inventoryItems.map((inventoryItemId) => ({
          inventoryItemId,
          locationId: location.id,
          quantity: safeQuantity,
        })),
      },
    },
  );

  throwUserErrors("Inventory update failed", data.inventorySetQuantities.userErrors);
  return { productGid, quantity: safeQuantity, updatedVariants: inventoryItems.length, locationName: location.name };
}
