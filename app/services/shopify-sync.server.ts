import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";
import { splitMedia } from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";
import { buildDescriptionHtml } from "./product-mapping.server";
import {
  cleanPublicDescription,
  getCorrectProductMapping,
  publicProductTags,
} from "./product-field-fixes.server";
import {
  getColorValue,
  getTargetGenderValue,
  setNativeCategoryMetafields,
} from "./shopify-native-category-metafields.server";
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

async function existingProductMedia(admin: AdminClient, handle: string) {
  try {
    const data = await graphql<{
      products: { nodes: Array<{ id: string; media: { nodes: Array<{ id: string }> } }> };
    }>(
      admin,
      `#graphql
        query ParserVoExistingProductMedia($query: String!) {
          products(first: 1, query: $query) {
            nodes { id media(first: 100) { nodes { id } } }
          }
        }
      `,
      { query: `handle:${handle}` },
    );
    const product = data.products.nodes[0];
    return {
      productId: product?.id || null,
      mediaIds: product?.media?.nodes?.map((item) => item.id).filter(Boolean) || [],
    };
  } catch {
    return { productId: null, mediaIds: [] as string[] };
  }
}

async function deleteOldMedia(
  admin: AdminClient,
  productId: string,
  mediaIds: string[],
) {
  if (!productId || !mediaIds.length) return [] as string[];
  try {
    const data = await graphql<{
      productDeleteMedia: {
        mediaUserErrors?: UserError[];
        userErrors?: UserError[];
      };
    }>(
      admin,
      `#graphql
        mutation ParserVoDeleteOldMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
            deletedMediaIds
            mediaUserErrors { field message }
            userErrors { field message }
          }
        }
      `,
      { productId, mediaIds },
    );
    return [
      ...(data.productDeleteMedia.mediaUserErrors || []),
      ...(data.productDeleteMedia.userErrors || []),
    ].map((error) => error.message);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function mapSupplierQuantity(
  rawQuantity: number | null | undefined,
  available: boolean | null | undefined,
  fallbackQuantity: number,
) {
  if (available === false || rawQuantity === 0) return 0;
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

function safeMediaFilename(handle: string, position: number, url: string) {
  let extension = "jpg";
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  } catch {
    // Keep jpg.
  }
  return `${handle}-image-${position}.${extension}`;
}

function customMetafields(productId: string, product: ParsedMarketplaceProduct) {
  const mapping = getCorrectProductMapping(product);
  const color = getColorValue(product);
  const targetGender = getTargetGenderValue(product);
  return [
    { ownerId: productId, namespace: "custom", key: "name_type", type: "single_line_text_field", value: mapping.nameType },
    { ownerId: productId, namespace: "custom", key: "disclosures", type: "single_line_text_field", value: "Передзамовлення. Доставка з Європи." },
    { ownerId: productId, namespace: "custom", key: "link", type: "url", value: product.sourceUrl },
    { ownerId: productId, namespace: "custom", key: "category_color", type: "single_line_text_field", value: color },
    { ownerId: productId, namespace: "custom", key: "category_target_gender", type: "single_line_text_field", value: targetGender },
  ].filter((entry) => String(entry.value || "").trim());
}

function productSetMetafields(product: ParsedMarketplaceProduct) {
  return customMetafields("", product).map(({ ownerId: _ownerId, ...entry }) => entry);
}

async function setCustomMetafields(
  admin: AdminClient,
  productId: string,
  product: ParsedMarketplaceProduct,
) {
  const metafields = customMetafields(productId, product);
  if (!metafields.length) return [] as string[];
  const data = await graphql<{
    metafieldsSet: {
      metafields?: Array<{ id: string }>;
      userErrors?: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoSetProductMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
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

  const pricing = calculatePricing({
    supplierPrice: product.price || 0,
    supplierOldPrice: product.compareAtPrice || null,
    currency: product.currency,
    eurRate: settings.eurRate,
    plnRate: settings.plnRate,
    roundingRule: "round_to_5",
    compareAtEnabled: true,
  });

  const mapping = getCorrectProductMapping(product);
  const taxonomy = await resolveShopifyTaxonomyCategory(admin, {
    ...product,
    productType: mapping.productType,
    productCategory: mapping.taxonomyPath,
  });
  const defaultVariant = variants.length === 1
    && ["DEFAULT TITLE", "ONE SIZE", "OS"].includes(variants[0].size.toUpperCase());
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
    filename: safeMediaFilename(handle, index + 1, image.url),
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

  const cleanDescription = cleanPublicDescription(product.descriptionHtml || product.description);
  const descriptionHtml = cleanDescription
    ? buildDescriptionHtml({ ...product, description: cleanDescription, descriptionHtml: null })
    : buildDescriptionHtml(product);
  const oldMedia = files.length ? await existingProductMedia(admin, handle) : { productId: null, mediaIds: [] as string[] };

  const input = {
    title: productTitle(product),
    handle,
    descriptionHtml,
    vendor: product.brand,
    productType: mapping.productType,
    status: "DRAFT",
    tags: publicProductTags(product, mapping.productType),
    metafields: productSetMetafields(product),
    ...(taxonomy.id ? { category: taxonomy.id } : {}),
    productOptions: [{
      name: optionName,
      position: 1,
      values: variants.map((variant) => ({
        name: defaultVariant ? "Default Title" : variant.size,
      })),
    }],
    ...(files.length ? { files } : {}),
    variants: variants.map((variant) => ({
      optionValues: [{
        optionName,
        name: defaultVariant ? "Default Title" : variant.size,
      }],
      sku: variant.sku || [product.supplierProductId, defaultVariant ? null : variant.size].filter(Boolean).join("-"),
      price: money(pricing.salePriceUah),
      compareAtPrice: pricing.compareAtPriceUah && pricing.compareAtPriceUah > pricing.salePriceUah
        ? money(pricing.compareAtPriceUah)
        : null,
      inventoryPolicy: "DENY",
      taxable: true,
      inventoryItem: {
        tracked: true,
        requiresShipping: true,
        cost: money(pricing.costPriceUah),
      },
      inventoryQuantities: [{
        locationId: location.id,
        name: "available",
        quantity: variant.quantity,
      }],
    })),
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
            id title handle
            media(first: 20) { nodes { id mediaContentType status } }
          }
          userErrors { code field message }
        }
      }
    `,
    { input, identifier: { handle }, synchronous: true },
  );

  throwUserErrors("Shopify sync failed", data.productSet.userErrors);
  if (!data.productSet.product) throw new Error("Shopify не вернул созданный или обновлённый товар.");

  const warnings: string[] = [];
  warnings.push(...await setCustomMetafields(admin, data.productSet.product.id, product));
  const native = await setNativeCategoryMetafields(admin, data.productSet.product.id, product);
  warnings.push(...native.errors);
  if (files.length && oldMedia.mediaIds.length) {
    warnings.push(...await deleteOldMedia(admin, data.productSet.product.id, oldMedia.mediaIds));
  }

  return {
    handle,
    productId: data.productSet.product.id,
    title: data.productSet.product.title,
    variants: variants.length,
    images: validImages.length,
    videos: validVideos.length,
    category: taxonomy.matchedFullName || taxonomy.requestedFullName || null,
    metafieldErrors: warnings.filter(Boolean),
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
