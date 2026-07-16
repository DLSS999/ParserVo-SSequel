import { calculatePricing, sortSizesForShopify } from "./pricing.server";
import { type ParsedMarketplaceProduct, splitMedia } from "./media.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export type ShopifyImportDraft = {
  title: string;
  vendor: string;
  productType: string;
  tags: string[];
  descriptionHtml: string;
  variants: Array<{
    optionName: string;
    optionValue: string;
    sku: string;
    price: string;
    compareAtPrice?: string | null;
    inventoryPolicy: "DENY" | "CONTINUE";
  }>;
  media: Array<{
    type: "IMAGE" | "VIDEO";
    url: string;
    alt?: string | null;
  }>;
  sourceUrl: string;
  processedFirstImage?: string | null;
};

function money(value: number | null | undefined) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric.toFixed(2) : "0.00";
}

function clean(value: string | null | undefined) {
  return String(value || "").trim();
}

export function buildShopifyImportDraft(product: ParsedMarketplaceProduct): ShopifyImportDraft {
  const pricing = calculatePricing({
    supplierPrice: product.price || 0,
    supplierOldPrice: product.compareAtPrice || null,
    currency: product.currency || "EUR",
    eurRate: 45,
    plnRate: 12.5,
    compareAtEnabled: true,
  });

  const sizes = sortSizesForShopify(product.sizes.length ? product.sizes : ["Default Title"]);
  const { images, videos, firstImage } = splitMedia(product.media);
  const tags = [
    product.source === "NET_A_PORTER" ? "NET-A-PORTER" : "MR PORTER",
    product.gender === "WOMEN" ? "Women" : "Men",
    "Підзамовлення",
    "Imported by ParserVo",
    product.brand,
    product.category,
  ].filter(Boolean);

  return {
    title: `${clean(product.brand)} ${clean(product.title)}`.trim(),
    vendor: clean(product.brand),
    productType: clean(product.category),
    tags,
    descriptionHtml: [product.description, product.composition ? `<p><strong>Composition:</strong> ${product.composition}</p>` : null]
      .filter(Boolean)
      .join("\n"),
    variants: sizes.map((size) => ({
      optionName: sizes.length === 1 && size === "Default Title" ? "Title" : "Size",
      optionValue: size,
      sku: [product.supplierProductId, size].filter(Boolean).join("-"),
      price: money(pricing.salePriceUah),
      compareAtPrice: pricing.compareAtPriceUah ? money(pricing.compareAtPriceUah) : null,
      inventoryPolicy: "DENY",
    })),
    media: [
      ...images.map((image) => ({ type: "IMAGE" as const, url: image.url, alt: image.alt || product.title })),
      ...videos.map((video) => ({ type: "VIDEO" as const, url: video.url, alt: video.alt || product.title })),
    ],
    sourceUrl: product.sourceUrl,
    processedFirstImage: firstImage?.url || null,
  };
}

export async function createShopifyProductFromDraft(admin: AdminClient, draft: ShopifyImportDraft) {
  const mutation = `#graphql
    mutation ProductCreate($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id title handle }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      product: {
        title: draft.title,
        vendor: draft.vendor,
        productType: draft.productType,
        tags: draft.tags,
        descriptionHtml: draft.descriptionHtml,
        status: "DRAFT",
      },
    },
  });
  const json = await response.json();
  const errors = json?.data?.productCreate?.userErrors || json?.errors;
  if (errors?.length) {
    throw new Error(errors.map((error: { message?: string }) => error.message || "Shopify error").join(" | "));
  }
  return json?.data?.productCreate?.product;
}
