import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";
import { splitMedia } from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";
import { buildDescriptionHtml, getProductMapping } from "./product-mapping.server";
import { stageVideoForProductSet } from "./shopify-staged-video.server";
import { resolveShopifyTaxonomyCategory } from "./shopify-taxonomy.server";

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
  videos: number;
  category: string | null;
  metafieldErrors: string[];
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

function isMirroredMedia(url: string) {
  return /\/storage\/v1\/object\/public\/parservo-media\//i.test(url)
    || /cdn\.shopify\.com/i.test(url);
}

function safeMediaFilename(handle: string, type: "image" | "video", position: number, url: string) {
  let extension = type === "video" ? "mp4" : "jpg";
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  } catch {
    // Use default extension.
  }
  return `${handle}-${type}-${position}.${extension}`;
}

async function setParserVoMetafields(
  admin: AdminClient,
  productId: string,
  product: ParsedMarketplaceProduct,
) {
  const mapping = getProductMapping(product);
  const metafields = [
    { ownerId: productId, namespace: "custom", key: "name_type", value: mapping.nameType },
    { ownerId: productId, namespace: "custom", key: "disclosures", value: "Передзамовлення. Доставка з Європи." },
    { ownerId: productId, namespace: "custom", key: "link", value: product.sourceUrl },
    {
      ownerId: productId,
      namespace: "parservo",
      key: "supplier_name",
      type: "single_line_text_field",
      value: product.source === "NET_A_PORTER" ? "NET-A-PORTER" : "MR PORTER",
    },
    {
      ownerId: productId,
      namespace: "parservo",
      key: "supplier_product_id",
      type: "single_line_text_field",
      value: String(product.supplierProductId || product.handle || ""),
    },
    { ownerId: productId, namespace: "parservo", key: "supplier_url", type: "url", value: product.sourceUrl },
  ].filter((entry) => String(entry.value || "").trim());

  const data = await graphql<{
    metafieldsSet: {
      metafields: Array<{ id: string; namespace: string; key: string }>;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoSetProductMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key }
          userErrors { code field message }
        }
      }
    `,
    { metafields },
  );

  return (data.metafieldsSet.userErrors || []).map((error) => error.message);
}

export async function syncProductToShopify(
  admin: AdminClient,
  product: ParsedMarketplaceProduct,
  settings: SyncSettings,
): Promise<SyncResult> {
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

  const mapping = getProductMapping(product);
  const taxonomy = await resolveShopifyTaxonomyCategory(admin, product);
  const baseCost = product.pricing?.costPriceUah ?? calculated.costPriceUah;
  const baseSale = product.pricing?.salePriceUah ?? calculated.salePriceUah;
  const baseCompareAt = product.pricing?.compareAtPriceUah ?? calculated.compareAtPriceUah;
  const defaultVariant = variants.length === 1 && ["DEFAULT TITLE", "ONE SIZE", "OS"].includes(variants[0].size.toUpperCase());
  const optionName = defaultVariant ? "Title" : "Розмір";
  const location = await resolveLocation(admin);
  if (!location) throw new Error("В Shopify не найдена активная локация для остатков.");

  const { images, videos } = splitMedia(product.media);
  const validImages = images
    .filter((item) => /^https?:\/\//i.test(item.url) && isMirroredMedia(item.url))
    .slice(0, 5);
  const validVideos = videos
    .filter((item) => /^https?:\/\//i.test(item.url) && isMirroredMedia(item.url))
    .slice(0, 1);

  const files: Array<Record<string, unknown>> = validImages.map((image, index) => ({
    originalSource: image.url,
    alt: image.alt || `${productTitle(product)} ${index + 1}`,
    filename: safeMediaFilename(handle, "image", index + 1, image.url),
    contentType: "IMAGE",
    duplicateResolutionMode: "REPLACE",
  }));

  for (let index = 0; index < validVideos.length; index += 1) {
    files.push(await stageVideoForProductSet({
      admin,
      video: validVideos[index],
      handle,
      position: index + 1,
    }));
  }

  const descriptionHtml = product.descriptionHtml || buildDescriptionHtml(product);
  const input = {
    title: productTitle(product),
    handle,
    descriptionHtml,
    vendor: product.brand,
    productType: mapping.productType,
    status: "DRAFT",
    tags: Array.from(new Set([
      ...(product.tags || []),
      product.source === "NET_A_PORTER" ? "NET-A-PORTER" : "MR PORTER",
      product.gender === "WOMEN" ? "Women" : "Men",
      mapping.productType,
      "Imported by ParserVo",
      "Preorder",
    ])),
    ...(taxonomy.id ? { category: taxonomy.id } : {}),
    productOptions: [{
      name: optionName,
      position: 1,
      values: variants.map((variant) => ({ name: defaultVariant ? "Default Title" : variant.size })),
    }],
    ...(files.length ? { files } : {}),
    variants: variants.map((variant) => {
      const cost = variant.costPriceUah ?? baseCost;
      const sale = variant.salePriceUah ?? baseSale;
      const compareAt = variant.compareAtPriceUah ?? baseCompareAt;
      return {
        optionValues: [{ optionName, name: defaultVariant ? "Default Title" : variant.size }],
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
      product: {
        id: string;
        title: string;
        handle: string;
        media: { nodes: Array<{ id: string; mediaContentType: string; status: string }> };
      } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoUpsertProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {
        productSet(input: $input, identifier: $identifier, synchronous: $synchronous) {
          product {
            id
            title
            handle
            media(first: 10) { nodes { id mediaContentType status } }
          }
          userErrors { code field message }
        }
      }
    `,
    { input, identifier: { handle }, synchronous: true },
  );

  throwUserErrors("Shopify sync failed", data.productSet.userErrors);
  if (!data.productSet.product) throw new Error("Shopify не вернул созданный или обновлённый товар.");

  const metafieldErrors = await setParserVoMetafields(admin, data.productSet.product.id, product);

  return {
    handle,
    productId: data.productSet.product.id,
    title: data.productSet.product.title,
    variants: variants.length,
    images: validImages.length,
    videos: validVideos.length,
    category: taxonomy.matchedFullName || taxonomy.requestedFullName || null,
    metafieldErrors,
    action: "created_or_updated",
  };
}

export async function syncCatalogToShopify(
  admin: AdminClient,
  products: ParsedMarketplaceProduct[],
  settings: SyncSettings,
) {
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
