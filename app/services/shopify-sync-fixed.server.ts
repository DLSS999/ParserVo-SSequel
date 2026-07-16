import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";
import { splitMedia } from "./media.server";
import { calculatePricing, sortSizesForShopify } from "./pricing.server";
import {
  cleanPublicDescription,
  getCorrectProductMapping,
  publicProductTags,
} from "./product-field-fixes.server";
import { setNativeCategoryMetafields } from "./shopify-native-category-metafields.server";
import { stageVideoForProductSet } from "./shopify-staged-video.server";
import { resolveShopifyTaxonomyCategory } from "./shopify-taxonomy.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type UserError = { field?: string[] | string | null; message: string; code?: string | null };

export type StrictSyncSettings = {
  eurRate: number;
  plnRate: number;
  defaultQuantity: number;
};

export type StrictSyncResult = {
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

function handleFor(product: ParsedMarketplaceProduct) {
  const raw = product.handle || product.supplierProductId || product.title;
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

function normalizedVendor(product: ParsedMarketplaceProduct) {
  const raw = String(product.brand || "").trim();
  return raw.toUpperCase() === "STONE ISLAND" ? "Stone Island" : raw;
}

function titleFor(product: ParsedMarketplaceProduct) {
  const brand = normalizedVendor(product);
  const title = String(product.title || "").trim();
  return title.toUpperCase().startsWith(brand.toUpperCase()) ? title : `${brand} ${title}`.trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exactDescriptionHtml(product: ParsedMarketplaceProduct) {
  if (product.descriptionHtml) return String(product.descriptionHtml).trim();
  const clean = cleanPublicDescription(product.description);
  if (!clean) return "";
  return clean
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
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
      query ParserVoStrictLocations {
        locations(first: 20) { nodes { id name isActive } }
      }
    `,
    {},
  );
  return data.locations.nodes.find((location) => location.isActive !== false) || data.locations.nodes[0] || null;
}

async function oldMedia(admin: AdminClient, handle: string) {
  try {
    const data = await graphql<{
      products: { nodes: Array<{ id: string; media: { nodes: Array<{ id: string }> } }> };
    }>(
      admin,
      `#graphql
        query ParserVoStrictOldMedia($query: String!) {
          products(first: 1, query: $query) {
            nodes { id media(first: 100) { nodes { id } } }
          }
        }
      `,
      { query: `handle:${handle}` },
    );
    const node = data.products.nodes[0];
    return {
      productId: node?.id || null,
      mediaIds: node?.media?.nodes?.map((item) => item.id).filter(Boolean) || [],
    };
  } catch {
    return { productId: null, mediaIds: [] as string[] };
  }
}

async function deleteMedia(admin: AdminClient, productId: string, mediaIds: string[]) {
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
        mutation ParserVoStrictDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
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

function mappedQuantity(
  raw: number | null | undefined,
  available: boolean | null | undefined,
  fallback: number,
  preserveExact: boolean,
) {
  if (available === false || raw === 0) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const normalized = Math.max(0, Math.trunc(raw));
    if (preserveExact) return normalized;
    if (normalized === 1) return 1;
    if (normalized > 1) return 5;
  }
  if (available === true) {
    return preserveExact
      ? Math.max(0, Math.trunc(fallback))
      : (fallback === 1 ? 1 : fallback > 1 ? 5 : 0);
  }
  return Math.max(0, Math.trunc(fallback));
}

function variantsFor(product: ParsedMarketplaceProduct, settings: StrictSyncSettings): ParsedMarketplaceVariant[] {
  const preserveExact = product.source === "STONE_ISLAND";
  const rows = product.variants?.length
    ? [...product.variants].sort((a, b) => a.position - b.position)
    : sortSizesForShopify(product.sizes.length ? product.sizes : ["Default Title"]).map((size, index) => ({
        size,
        quantity: settings.defaultQuantity,
        available: settings.defaultQuantity > 0,
        position: index + 1,
      }));

  return rows
    .map((variant) => ({
      ...variant,
      quantity: mappedQuantity(variant.quantity, variant.available, settings.defaultQuantity, preserveExact),
    }))
    .filter((variant) => variant.quantity > 0);
}

function isSupportedPublicMediaUrl(urlValue: string) {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;

    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    if (pathname.includes("/storage/v1/object/public/parservo-media/")) return true;
    if (hostname === "cdn.shopify.com" || hostname.endsWith(".cdn.shopify.com")) return true;
    if (hostname === "stoneisland-cdn.thron.com" || hostname.endsWith(".thron.com")) {
      return pathname.includes("/delivery/public/image/stoneisland/");
    }

    return false;
  } catch {
    return false;
  }
}

function imageFilename(handle: string, position: number, url: string) {
  let extension = "jpg";
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  } catch {
    // Keep jpg.
  }
  return `${handle}-image-${position}.${extension}`;
}

async function customMetafieldType(
  admin: AdminClient,
  key: string,
  fallback: string,
) {
  try {
    const data = await graphql<{
      metafieldDefinition: { type?: { name?: string | null } | null } | null;
    }>(
      admin,
      `#graphql
        query ParserVoCustomDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
          metafieldDefinition(identifier: $identifier) { type { name } }
        }
      `,
      { identifier: { ownerType: "PRODUCT", namespace: "custom", key } },
    );
    return data.metafieldDefinition?.type?.name || fallback;
  } catch {
    return fallback;
  }
}

async function setCustomFields(admin: AdminClient, productId: string, product: ParsedMarketplaceProduct) {
  const mapping = getCorrectProductMapping(product);
  const sourceUrl = String(product.sourceUrl || "").trim();
  const inputs = [
    {
      ownerId: productId,
      namespace: "custom",
      key: "name_type",
      type: await customMetafieldType(admin, "name_type", "single_line_text_field"),
      value: mapping.nameType,
    },
    ...(sourceUrl ? [{
      ownerId: productId,
      namespace: "custom",
      key: "link",
      type: await customMetafieldType(admin, "link", "url"),
      value: sourceUrl,
    }] : []),
  ];

  const errors: string[] = [];
  for (const metafield of inputs) {
    try {
      const data = await graphql<{
        metafieldsSet: {
          metafields?: Array<{ id: string }>;
          userErrors?: UserError[];
        };
      }>(
        admin,
        `#graphql
          mutation ParserVoStrictCustomField($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
              userErrors { code field message }
            }
          }
        `,
        { metafields: [metafield] },
      );
      errors.push(...(data.metafieldsSet.userErrors || []).map((error) => `${metafield.key}: ${error.message}`));
    } catch (error) {
      errors.push(`${metafield.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export async function syncProductToShopifyStrict(
  admin: AdminClient,
  product: ParsedMarketplaceProduct,
  settings: StrictSyncSettings,
): Promise<StrictSyncResult> {
  const handle = handleFor(product);
  const variants = variantsFor(product, settings);
  if (!variants.length) throw new Error(`Товар ${titleFor(product)} пропущен: нет размеров в наличии.`);

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
  const location = await resolveLocation(admin);
  if (!location) throw new Error("В Shopify не найдена активная локация для остатков.");

  const defaultVariant = variants.length === 1
    && ["DEFAULT TITLE"].includes(variants[0].size.toUpperCase());
  const sizeOptionName = defaultVariant ? "Title" : "Розмір";
  const color = String(product.color || "").replace(/^colou?r\s*:\s*/i, "").trim();
  if (product.source === "STONE_ISLAND" && !color) {
    throw new Error("Stone Island product color is missing.");
  }

  const { images, videos } = splitMedia(product.media);
  const exactImages = images.filter((item) => isSupportedPublicMediaUrl(item.url)).slice(0, 5);
  const exactVideos = videos.filter((item) => isSupportedPublicMediaUrl(item.url)).slice(0, 1);
  if (!exactImages.length) throw new Error("Нет проверенных фотографий текущего товара.");

  const files: Array<Record<string, unknown>> = exactImages.map((image, index) => ({
    originalSource: image.url,
    alt: image.alt || `${titleFor(product)} ${index + 1}`,
    filename: imageFilename(handle, index + 1, image.url),
    contentType: "IMAGE",
    duplicateResolutionMode: "REPLACE",
  }));
  for (let index = 0; index < exactVideos.length; index += 1) {
    files.push(await stageVideoForProductSet({
      admin,
      video: exactVideos[index],
      handle,
      position: index + 1,
    }));
  }

  const previous = await oldMedia(admin, handle);
  const input = {
    title: titleFor(product),
    handle,
    descriptionHtml: exactDescriptionHtml(product),
    vendor: normalizedVendor(product),
    productType: mapping.productType,
    status: "DRAFT",
    tags: publicProductTags(product, mapping.productType),
    ...(taxonomy.id ? { category: taxonomy.id } : {}),
    productOptions: [{
      name: sizeOptionName,
      position: 1,
      values: variants.map((variant) => ({ name: defaultVariant ? "Default Title" : variant.size })),
    }],
    files,
    variants: variants.map((variant) => ({
      optionValues: [
        { optionName: sizeOptionName, name: defaultVariant ? "Default Title" : variant.size },
      ],
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
      product: { id: string; title: string; handle: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoStrictUpsert($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {
        productSet(input: $input, identifier: $identifier, synchronous: $synchronous) {
          product { id title handle }
          userErrors { code field message }
        }
      }
    `,
    { input, identifier: { handle }, synchronous: true },
  );
  throwUserErrors("Shopify sync failed", data.productSet.userErrors);
  if (!data.productSet.product) throw new Error("Shopify не вернул созданный или обновлённый товар.");

  const warnings: string[] = [];
  warnings.push(...await setCustomFields(admin, data.productSet.product.id, product));
  const native = await setNativeCategoryMetafields(admin, data.productSet.product.id, {
    ...product,
    productType: mapping.productType,
    productCategory: mapping.taxonomyPath,
  });
  warnings.push(...native.errors);
  if (previous.mediaIds.length) {
    warnings.push(...await deleteMedia(admin, data.productSet.product.id, previous.mediaIds));
  }

  return {
    handle,
    productId: data.productSet.product.id,
    title: data.productSet.product.title,
    variants: variants.length,
    images: exactImages.length,
    videos: exactVideos.length,
    category: taxonomy.matchedFullName || taxonomy.requestedFullName || null,
    metafieldErrors: warnings.filter(Boolean),
    action: "created_or_updated",
  };
}
