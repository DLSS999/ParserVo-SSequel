import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigate, useNavigation } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { authenticate } from "../shopify.server";
import db from "../db.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type SeoFilters = {
  q: string;
  brand: string;
  audit: string;
};

type ShopifySeoValue = {
  title: string;
  description: string;
};

const SEO_PAGE_SIZE_OPTIONS = [25, 50, 100];
const SEO_FILTER_QUERY_KEYS = ["page", "pageSize", "q", "brand", "audit"];
const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 160;

function safeText(value: unknown) {
  return String(value || "").trim();
}

function compact(value: string) {
  return safeText(value).replace(/\s+/g, " ").trim();
}

function truncateText(value: string, max: number) {
  const clean = compact(value);
  if (clean.length <= max) return clean;
  return compact(clean.slice(0, Math.max(0, max - 1)).replace(/[\s,.;:|—-]+$/g, "")) + "…";
}

function normalizeMoneyText(value: unknown) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toLocaleString("uk-UA", { maximumFractionDigits: 0 });
}

function legacyIdFromGid(gid: string | null | undefined) {
  return safeText(gid).split("/").pop() || "";
}

function parsePage(value: string | null) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 1;
}

function parsePageSize(value: string | null) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  return SEO_PAGE_SIZE_OPTIONS.includes(parsed) ? parsed : 50;
}

function readSeoFilters(url: URL): SeoFilters {
  return {
    q: safeText(url.searchParams.get("q")),
    brand: safeText(url.searchParams.get("brand")) || "all",
    audit: safeText(url.searchParams.get("audit")) || "all",
  };
}

function containsInsensitive(value: string) {
  return { contains: value, mode: "insensitive" as const };
}

function buildSeoWhere(shop: string, filters: SeoFilters) {
  const and: any[] = [
    { shop },
    { shopifyProductGid: { not: null } },
  ];

  const qTokens = filters.q.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  for (const token of qTokens) {
    and.push({
      OR: [
        { originalTitle: containsInsensitive(token) },
        { title: containsInsensitive(token) },
        { brand: containsInsensitive(token) },
        { supplierSymbol: containsInsensitive(token) },
        { modelCode: containsInsensitive(token) },
        { supplierProductId: containsInsensitive(token) },
        { supplierUrl: containsInsensitive(token) },
        { category: containsInsensitive(token) },
        { categoryUa: containsInsensitive(token) },
        { productType: containsInsensitive(token) },
      ],
    });
  }

  if (filters.brand !== "all") {
    and.push({ brand: filters.brand });
  }

  return { AND: and };
}

async function shopifyGraphql<T>(admin: AdminClient, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify API HTTP ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message?: string }) => error.message || "Unknown GraphQL error").join(" | "));
  }

  return json.data as T;
}

function colorUa(product: any) {
  const source = safeText(product.color || product.colorUa).toUpperCase().replace(/[\s_/-]+/g, " ");
  const map: Record<string, string> = {
    BEIGE: "бежевий", CREAM: "бежевий", IVORY: "бежевий", ECRU: "бежевий",
    BLACK: "чорний", WHITE: "білий", BLUE: "синій", NAVY: "темно-синій",
    GREY: "сірий", GRAY: "сірий", PINK: "рожевий", RED: "червоний",
    GREEN: "зелений", BROWN: "коричневий", YELLOW: "жовтий", ORANGE: "помаранчевий",
    GOLD: "золотистий", SILVER: "сріблястий", PURPLE: "фіолетовий",
    БЕЖЕВИЙ: "бежевий", ЧОРНИЙ: "чорний", БІЛИЙ: "білий", СІРИЙ: "сірий",
    РОЖЕВИЙ: "рожевий", ЧЕРВОНИЙ: "червоний", СИНІЙ: "синій", ЗЕЛЕНИЙ: "зелений",
  };
  return map[source] || map[source.split(" ")[0]] || "";
}

function detectKind(product: any) {
  const text = ` ${[product.originalTitle, product.title, product.category, product.categoryUa, product.productType, product.breadcrumbs]
    .filter(Boolean).join(" ")} `.toLowerCase();

  if (/shoulder bag|сумк[аи] на плече/.test(text)) return "shoulder_bag";
  if (/backpack|рюкзак/.test(text)) return "backpack";
  if (/shopper|tote|шопер/.test(text)) return "shopper";
  if (/bag|handbag|сумк/.test(text)) return "bag";
  if (/sneaker|trainer|sports shoes|кросівк/.test(text)) return "sneakers";
  if (/slides?|slippers?|flip flops?|шльопанц/.test(text)) return "slides";
  if (/loafers?|лофер/.test(text)) return "loafers";
  if (/boots?|черевик/.test(text)) return "boots";
  if (/sandals?|сандал|босоніж/.test(text)) return "sandals";
  if (/shoes?|pumps?|heels?|туфл/.test(text)) return "shoes";
  if (/belts?|ремен/.test(text)) return "belt";
  if (/caps?|кепк/.test(text)) return "cap";
  if (/hats?|beanie|шапк|капелюх/.test(text)) return "hat";
  if (/scarves?|shawls?|шарф/.test(text)) return "scarf";
  if (/socks?|шкарпет/.test(text)) return "socks";
  if (/swim shorts|swimming shorts|плавк|шорти для плавання/.test(text)) return "swim_shorts";
  if (/shorts|шорти/.test(text)) return "shorts";
  if (/jeans|джинс/.test(text)) return "jeans";
  if (/trousers?|pants|брюк|штани/.test(text)) return "trousers";
  if (/puffer|down jacket|пухов/.test(text)) return "down_jacket";
  if (/bomber|jacket|куртк/.test(text)) return "jacket";
  if (/coat|пальт/.test(text)) return "coat";
  if (/cardigan|кардиган/.test(text)) return "cardigan";
  if (/zip[-\s]?hoodie|зіп[-\s]?худі/.test(text)) return "zip_hoodie";
  if (/hoodie|худі/.test(text)) return "hoodie";
  if (/sweatshirt|світшот/.test(text)) return "sweatshirt";
  if (/sweater|pullover|knitwear|светр/.test(text)) return "sweater";
  if (/polo|поло/.test(text)) return "polo";
  if (/t[-\s]?shirt|\btee\b|футболк/.test(text)) return "tshirt";
  if (/long[-\s]?sleeve|лонгслів/.test(text)) return "longsleeve";
  if (/shirt|сорочк/.test(text)) return "shirt";
  if (/bodysuit|боді/.test(text)) return "bodysuit";
  if (/top|топ/.test(text)) return "top";
  return "product";
}

function nameTypeUa(product: any) {
  const map: Record<string, string> = {
    shoulder_bag: "сумка на плече", backpack: "рюкзак", shopper: "шопер", bag: "сумка",
    sneakers: "кросівки", slides: "шльопанці", loafers: "лофери", boots: "черевики", sandals: "сандалі", shoes: "туфлі",
    belt: "ремінь", cap: "кепка", hat: "шапка", scarf: "шарф", socks: "шкарпетки",
    swim_shorts: "шорти для плавання", shorts: "шорти", jeans: "джинси", trousers: "брюки",
    down_jacket: "пуховик", jacket: "куртка", coat: "пальто", cardigan: "кардиган",
    zip_hoodie: "зіп-худі", hoodie: "худі", sweatshirt: "світшот", sweater: "светр",
    polo: "поло", tshirt: "футболка", longsleeve: "лонгслів", shirt: "сорочка", bodysuit: "боді", top: "топ",
    product: "товар",
  };
  return map[detectKind(product)] || "товар";
}

function cleanModelName(product: any) {
  const brand = safeText(product.brand);
  const kind = nameTypeUa(product);
  let value = safeText(product.originalTitle || product.title);

  if (brand) value = value.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");

  const wordsToRemove = [
    "black", "white", "grey", "gray", "beige", "cream", "blue", "navy", "pink", "red", "green", "brown", "yellow", "orange", "gold", "silver",
    "t-shirt", "tshirt", "tee", "sweatshirt", "sweater", "shirt", "polo", "hoodie", "jacket", "coat", "shorts", "trousers", "pants", "jeans",
    "sneakers", "sports shoes", "shoes", "slides", "bag", "shoulder bag", "backpack", "cap", "hat", "scarf", "belt",
    "with", "logo", "printed", "embroidered", "patch",
    kind,
  ];

  for (const word of wordsToRemove) {
    if (!word) continue;
    value = value.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), " ");
  }

  return compact(value.replace(/[‘’'"()]+/g, " ")).slice(0, 45);
}

function buildGeneratedSeo(product: any): ShopifySeoValue {
  const brand = safeText(product.brand);
  const model = cleanModelName(product);
  const nameType = nameTypeUa(product);
  const color = colorUa(product);
  const sku = safeText(product.modelCode || product.supplierSymbol || product.supplierProductId);
  const price = normalizeMoneyText(product.salePriceUah);

  const titleCore = compact(`${brand}${model ? ` ${model}` : ""} ${color ? `${color} ` : ""}${nameType}${sku ? ` ${sku}` : ""}`);
  const title = truncateText(`${titleCore} — купити в Україні | CINQ`, SEO_TITLE_MAX);

  const descriptionParts = [
    `Оригінальний ${compact(`${brand}${model ? ` ${model}` : ""} ${color ? `${color} ` : ""}${nameType}`)} у CINQ.`,
    price ? `Ціна ${price} грн.` : "Актуальна наявність.",
    "Доставка по Україні, допомога з розміром та перевірені постачальники з Європи й США.",
  ];
  const description = truncateText(descriptionParts.join(" "), SEO_DESCRIPTION_MAX);

  return { title, description };
}

function seoStatus(generated: ShopifySeoValue, current?: ShopifySeoValue | null) {
  if (generated.title.length > SEO_TITLE_MAX) return { label: "Title long", className: "badge badge-red" };
  if (generated.description.length > SEO_DESCRIPTION_MAX) return { label: "Description long", className: "badge badge-red" };
  if (!current?.title && !current?.description) return { label: "Missing in Shopify", className: "badge badge-yellow" };
  if (current?.title === generated.title && current?.description === generated.description) return { label: "SEO OK", className: "badge badge-green" };
  return { label: "Needs update", className: "badge badge-yellow" };
}

async function fetchShopifySeoMap(admin: AdminClient, productGids: string[]) {
  const ids = Array.from(new Set(productGids.filter(Boolean))).slice(0, 100);
  if (ids.length === 0) return new Map<string, ShopifySeoValue>();

  const data = await shopifyGraphql<{
    nodes: Array<null | { id: string; seo?: { title?: string | null; description?: string | null } | null }>;
  }>(
    admin,
    `#graphql
    query ParserVoSeoProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          seo { title description }
        }
      }
    }`,
    { ids },
  );

  const map = new Map<string, ShopifySeoValue>();
  for (const node of data.nodes || []) {
    if (!node?.id) continue;
    map.set(node.id, {
      title: safeText(node.seo?.title),
      description: safeText(node.seo?.description),
    });
  }
  return map;
}

async function updateShopifyProductSeo(admin: AdminClient, productGid: string, seo: ShopifySeoValue) {
  const data = await shopifyGraphql<{
    productUpdate: {
      product?: { id: string; seo?: { title?: string | null; description?: string | null } | null } | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoUpdateProductSeo($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id seo { title description } }
        userErrors { field message }
      }
    }`,
    {
      input: {
        id: productGid,
        seo: {
          title: seo.title,
          description: seo.description,
        },
      },
    },
  );

  const errors = data.productUpdate.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" | "));
  }

  return data.productUpdate.product;
}

function getIdsFromForm(formData: FormData, key: string) {
  return Array.from(new Set(formData.getAll(key).map((value) => String(value)).filter(Boolean)));
}

function getExcludedIdsFromForm(formData: FormData) {
  return getIdsFromForm(formData, "excludedProductIds");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceTextBlock(value: unknown, findText: string, replaceWith: string) {
  const source = String(value || "");
  const find = safeText(findText);
  if (!source || !find) return source;
  return source.replace(new RegExp(escapeRegExp(find), "gi"), replaceWith);
}

function hasTextChanged(before: unknown, after: unknown) {
  return String(before || "") !== String(after || "");
}

function readReplaceFields(formData: FormData) {
  return new Set(formData.getAll("replaceFields").map((value) => String(value)).filter(Boolean));
}

function buildBulkReplaceWhere(shop: string, filters: SeoFilters, findText: string) {
  const find = safeText(findText);
  const baseWhere = buildSeoWhere(shop, filters);
  if (!find) return baseWhere;

  return {
    AND: [
      baseWhere,
      {
        OR: [
          { brand: containsInsensitive(find) },
          { originalTitle: containsInsensitive(find) },
          { title: containsInsensitive(find) },
          { category: containsInsensitive(find) },
          { categoryUa: containsInsensitive(find) },
          { productType: containsInsensitive(find) },
          { supplierSymbol: containsInsensitive(find) },
          { modelCode: containsInsensitive(find) },
          { supplierProductId: containsInsensitive(find) },
        ],
      },
    ],
  };
}

async function updateShopifyProductFields(admin: AdminClient, input: Record<string, unknown>) {
  const data = await shopifyGraphql<{
    productUpdate: {
      product?: { id: string } | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoBulkUpdateProductFields($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`,
    { input },
  );

  const errors = data.productUpdate.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join(" | "));
  return data.productUpdate.product;
}

type BulkReplacePreviewRow = {
  id: string;
  title: string;
  sku: string;
  brandBefore: string;
  brandAfter: string;
  changedFields: string[];
};

function buildBulkReplacePreview(product: any, currentSeo: ShopifySeoValue | undefined, findText: string, replaceWith: string, fields: Set<string>): BulkReplacePreviewRow {
  const changedFields: string[] = [];
  const brandAfter = fields.has("parservo_brand") ? replaceTextBlock(product.brand, findText, replaceWith) : safeText(product.brand);
  if (fields.has("parservo_brand") && hasTextChanged(product.brand, brandAfter)) changedFields.push("ParserVo brand");

  if (fields.has("parservo_title") && hasTextChanged(product.title, replaceTextBlock(product.title, findText, replaceWith))) changedFields.push("ParserVo title");
  if (fields.has("parservo_original_title") && hasTextChanged(product.originalTitle, replaceTextBlock(product.originalTitle, findText, replaceWith))) changedFields.push("ParserVo original title");

  const productForSeo = { ...product, brand: brandAfter };
  const generated = buildGeneratedSeo(productForSeo);
  const seoTitleSource = currentSeo?.title || generated.title;
  const seoDescriptionSource = currentSeo?.description || generated.description;

  if (fields.has("shopify_vendor") && hasTextChanged(product.brand, replaceTextBlock(product.brand, findText, replaceWith))) changedFields.push("Shopify vendor");
  if (fields.has("shopify_title") && hasTextChanged(product.originalTitle || product.title, replaceTextBlock(product.originalTitle || product.title, findText, replaceWith))) changedFields.push("Shopify title");
  if (fields.has("shopify_seo_title") && hasTextChanged(seoTitleSource, replaceTextBlock(seoTitleSource, findText, replaceWith))) changedFields.push("Shopify SEO title");
  if (fields.has("shopify_seo_description") && hasTextChanged(seoDescriptionSource, replaceTextBlock(seoDescriptionSource, findText, replaceWith))) changedFields.push("Shopify meta description");

  return {
    id: product.id,
    title: safeText(product.originalTitle || product.title),
    sku: safeText(product.supplierSymbol || product.modelCode || product.supplierProductId),
    brandBefore: safeText(product.brand),
    brandAfter: safeText(brandAfter),
    changedFields,
  };
}

async function applyBulkReplace(admin: AdminClient, shop: string, products: any[], findText: string, replaceWith: string, fields: Set<string>) {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const seoMap = await fetchShopifySeoMap(admin, products.map((product: any) => product.shopifyProductGid));

  for (const product of products) {
    const changedFields: string[] = [];
    try {
      const dbUpdate: Record<string, string> = {};

      if (fields.has("parservo_brand")) {
        const next = replaceTextBlock(product.brand, findText, replaceWith);
        if (hasTextChanged(product.brand, next)) {
          dbUpdate.brand = next;
          changedFields.push("ParserVo brand");
        }
      }

      if (fields.has("parservo_title")) {
        const next = replaceTextBlock(product.title, findText, replaceWith);
        if (hasTextChanged(product.title, next)) {
          dbUpdate.title = next;
          changedFields.push("ParserVo title");
        }
      }

      if (fields.has("parservo_original_title")) {
        const next = replaceTextBlock(product.originalTitle, findText, replaceWith);
        if (hasTextChanged(product.originalTitle, next)) {
          dbUpdate.originalTitle = next;
          changedFields.push("ParserVo original title");
        }
      }

      if (Object.keys(dbUpdate).length) {
        await db.importedProduct.update({ where: { id: product.id }, data: dbUpdate as any });
      }

      const productForSeo = { ...product, ...dbUpdate };
      const shopifyInput: Record<string, unknown> = { id: product.shopifyProductGid };

      if (fields.has("shopify_vendor")) {
        const nextVendor = replaceTextBlock(product.brand, findText, replaceWith);
        if (hasTextChanged(product.brand, nextVendor)) {
          shopifyInput.vendor = nextVendor;
          changedFields.push("Shopify vendor");
        }
      }

      if (fields.has("shopify_title")) {
        const titleSource = safeText(product.originalTitle || product.title);
        const nextTitle = replaceTextBlock(titleSource, findText, replaceWith);
        if (hasTextChanged(titleSource, nextTitle)) {
          shopifyInput.title = nextTitle;
          changedFields.push("Shopify title");
        }
      }

      const currentSeo = seoMap.get(product.shopifyProductGid);
      const generated = buildGeneratedSeo(productForSeo);
      const nextSeo: ShopifySeoValue = {
        title: currentSeo?.title || generated.title,
        description: currentSeo?.description || generated.description,
      };
      let seoChanged = false;

      if (fields.has("shopify_seo_title")) {
        const next = truncateText(replaceTextBlock(nextSeo.title, findText, replaceWith), SEO_TITLE_MAX);
        if (hasTextChanged(nextSeo.title, next)) {
          nextSeo.title = next;
          seoChanged = true;
          changedFields.push("Shopify SEO title");
        }
      }

      if (fields.has("shopify_seo_description")) {
        const next = truncateText(replaceTextBlock(nextSeo.description, findText, replaceWith), SEO_DESCRIPTION_MAX);
        if (hasTextChanged(nextSeo.description, next)) {
          nextSeo.description = next;
          seoChanged = true;
          changedFields.push("Shopify meta description");
        }
      }

      if (seoChanged) shopifyInput.seo = nextSeo;

      if (Object.keys(shopifyInput).length > 1) {
        await updateShopifyProductFields(admin, shopifyInput);
      }

      if (changedFields.length) {
        updated += 1;
        await db.syncLog.create({
          data: {
            shop,
            importedProductId: product.id,
            supplierName: product.supplierName,
            supplierUrl: product.supplierUrl,
            status: "bulk_text_replace_synced",
            message: `Bulk replace '${findText}' → '${replaceWith}': ${changedFields.join(", ")}`,
          },
        });
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.originalTitle || product.title}: ${message}`);
      await db.syncLog.create({
        data: {
          shop,
          importedProductId: product.id,
          supplierName: product.supplierName,
          supplierUrl: product.supplierUrl,
          status: "bulk_text_replace_error",
          message: `Bulk replace failed: ${message.slice(0, 450)}`,
          errorMessage: message,
        },
      });
    }
  }

  return { total: products.length, updated, skipped, failed, errors, processedIds: products.map((product: any) => product.id) };
}


type BrandNormalizeFields = {
  parservoBrand: boolean;
  shopifyVendor: boolean;
  regenerateSeo: boolean;
};

function readBrandNormalizeFields(formData: FormData): BrandNormalizeFields {
  const fields = new Set(formData.getAll("brandNormalizeFields").map((value) => String(value)).filter(Boolean));
  return {
    parservoBrand: fields.has("parservo_brand"),
    shopifyVendor: fields.has("shopify_vendor"),
    regenerateSeo: fields.has("regenerate_seo"),
  };
}

function buildBrandNormalizeWhere(shop: string, filters: SeoFilters, fromBrand: string, targetBrand: string, excludedIds: string[] = []) {
  const and: any[] = [buildSeoWhere(shop, filters)];
  const from = safeText(fromBrand);
  const target = safeText(targetBrand);

  if (filters.brand === "all" && from && from !== "all") {
    and.push({ brand: from });
  } else if (filters.brand === "all" && target) {
    // Если ParserVo brand уже заменили раньше, можно оставить старый бренд пустым
    // и принудительно дожать Shopify vendor / SEO по целевому бренду.
    and.push({ brand: containsInsensitive(target) });
  }

  if (excludedIds.length) and.push({ id: { notIn: excludedIds } });
  return { AND: and };
}

async function applyBrandNormalization(admin: AdminClient, shop: string, products: any[], targetBrand: string, fields: BrandNormalizeFields) {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const processedIds: string[] = [];

  for (const product of products) {
    processedIds.push(product.id);
    const changedFields: string[] = [];
    try {
      const cleanTargetBrand = safeText(targetBrand);
      if (!cleanTargetBrand) throw new Error("Target brand is empty.");
      if (!product.shopifyProductGid && (fields.shopifyVendor || fields.regenerateSeo)) throw new Error("Product is not linked to Shopify.");

      const dbUpdate: Record<string, string> = {};
      if (fields.parservoBrand && safeText(product.brand) !== cleanTargetBrand) {
        dbUpdate.brand = cleanTargetBrand;
        changedFields.push("ParserVo brand");
      }

      if (Object.keys(dbUpdate).length) {
        await db.importedProduct.update({ where: { id: product.id }, data: dbUpdate as any });
      }

      const productForSeo = { ...product, ...dbUpdate, brand: cleanTargetBrand };
      const shopifyInput: Record<string, unknown> = { id: product.shopifyProductGid };

      if (fields.shopifyVendor && product.shopifyProductGid) {
        // Важно: это НЕ replace по тексту. Это принудительно ставит Vendor в Shopify.
        shopifyInput.vendor = cleanTargetBrand;
        changedFields.push("Shopify vendor");
      }

      if (fields.regenerateSeo && product.shopifyProductGid) {
        shopifyInput.seo = buildGeneratedSeo(productForSeo);
        changedFields.push("Generated SEO");
      }

      if (Object.keys(shopifyInput).length > 1) {
        await updateShopifyProductFields(admin, shopifyInput);
      }

      if (changedFields.length) {
        updated += 1;
        await db.syncLog.create({
          data: {
            shop,
            importedProductId: product.id,
            supplierName: product.supplierName,
            supplierUrl: product.supplierUrl,
            status: "brand_normalization_synced",
            message: `Brand normalization → '${cleanTargetBrand}': ${changedFields.join(", ")}`,
          },
        });
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.originalTitle || product.title}: ${message}`);
      await db.syncLog.create({
        data: {
          shop,
          importedProductId: product.id,
          supplierName: product.supplierName,
          supplierUrl: product.supplierUrl,
          status: "brand_normalization_error",
          message: `Brand normalization failed: ${message.slice(0, 450)}`,
          errorMessage: message,
        },
      });
    }
  }


  return { total: products.length, updated, skipped, failed, errors, processedIds };
}

type ShopifyStoreProduct = {
  id: string;
  title: string;
  vendor: string;
  productType?: string | null;
  handle?: string | null;
  status?: string | null;
  seo?: { title?: string | null; description?: string | null } | null;
  variants?: { nodes?: Array<{ sku?: string | null; price?: string | null }> } | null;
  nameTypeMetafield?: { value?: string | null } | null;
  filterNameMetafield?: { value?: string | null } | null;
  colorMetafield?: { value?: string | null } | null;
  productVariantMetafield?: { value?: string | null } | null;
};

type StoreWideNormalizeFields = {
  shopifyVendor: boolean;
  regenerateSeo: boolean;
  replaceProductTitle: boolean;
};

function readStoreWideFields(formData: FormData): StoreWideNormalizeFields {
  const fields = new Set(formData.getAll("storeWideFields").map((value) => String(value)).filter(Boolean));
  return {
    shopifyVendor: fields.has("shopify_vendor"),
    regenerateSeo: fields.has("regenerate_seo"),
    replaceProductTitle: fields.has("shopify_title_replace"),
  };
}

function shopifyProductAdminUrl(shop: string, gid: string) {
  return `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/products/${legacyIdFromGid(gid)}`;
}

function cleanShopifySearchQuery(value: unknown) {
  return compact(String(value || ""));
}

type ShopifyProductsPage = {
  products: ShopifyStoreProduct[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
};

async function fetchShopifyStoreProductsPage(admin: AdminClient, queryText: string, limit: number, afterCursor?: string | null): Promise<ShopifyProductsPage> {
  const data = await shopifyGraphql<{
    products: {
      nodes: ShopifyStoreProduct[];
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  }>(
    admin,
    `#graphql
    query ParserVoStoreWideSeoProducts($first: Int!, $query: String, $after: String) {
      products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          vendor
          productType
          handle
          status
          seo { title description }
          variants(first: 1) { nodes { sku price } }
          nameTypeMetafield: metafield(namespace: "custom", key: "name_type") { value }
          filterNameMetafield: metafield(namespace: "custom", key: "filter_name") { value }
          colorMetafield: metafield(namespace: "custom", key: "color") { value }
          productVariantMetafield: metafield(namespace: "custom", key: "product_variant") { value }
        }
      }
    }`,
    { first: limit, query: queryText || null, after: afterCursor || null },
  );

  return {
    products: data.products.nodes || [],
    pageInfo: data.products.pageInfo || { hasNextPage: false, endCursor: null },
  };
}

async function fetchShopifyStoreProducts(admin: AdminClient, queryText: string, limit: number) {
  const page = await fetchShopifyStoreProductsPage(admin, queryText, limit, null);
  return page.products;
}


function buildGeneratedSeoFromShopifyProduct(product: ShopifyStoreProduct, targetBrand: string) {
  return buildGeneratedSeo({
    brand: safeText(targetBrand || product.vendor),
    originalTitle: product.title,
    title: product.title,
    productType: product.productType,
    category: product.productType,
    salePriceUah: 0,
  });
}


type TemplateSeoValue = {
  titleTemplate: string;
  descriptionTemplate: string;
};

function templateValue(value: unknown) {
  return compact(String(value || ""));
}

function renderTemplate(template: string, values: Record<string, unknown>) {
  let output = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    output = output.replace(new RegExp(`\\{${escapeRegExp(key)}\\}`, "gi"), templateValue(value));
  }
  return compact(output.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+—\s+/g, " — "));
}

function firstShopifyVariant(product: ShopifyStoreProduct) {
  return product.variants?.nodes?.[0] || {};
}

function normalizeShopifyPriceText(value: unknown) {
  const raw = String(value || "").replace(/\s/g, "").replace(",", ".");
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toLocaleString("uk-UA", { maximumFractionDigits: 0 });
}

function shopifyTemplateValues(product: ShopifyStoreProduct, targetVendor?: string) {
  const variant = firstShopifyVariant(product);
  const nameType = safeText(product.nameTypeMetafield?.value || product.productType);
  const filterName = safeText(product.filterNameMetafield?.value);
  const color = safeText(product.colorMetafield?.value);
  const sku = safeText(variant.sku);
  const price = normalizeShopifyPriceText(variant.price);
  return {
    vendor: safeText(targetVendor || product.vendor),
    brand: safeText(targetVendor || product.vendor),
    name: safeText(product.title),
    title: safeText(product.title),
    type: safeText(product.productType),
    productType: safeText(product.productType),
    nameType,
    name_type: nameType,
    filterName,
    filter_name: filterName,
    color,
    productVariant: safeText(product.productVariantMetafield?.value),
    product_variant: safeText(product.productVariantMetafield?.value),
    sku,
    price,
    handle: safeText(product.handle),
    status: safeText(product.status),
    store: "CINQ",
  };
}

function parserVoTemplateValues(product: any) {
  return {
    brand: safeText(product.brand),
    vendor: safeText(product.brand),
    title: safeText(product.originalTitle || product.title),
    type: safeText(product.productType || product.categoryUa || product.category),
    nameType: nameTypeUa(product),
    color: colorUa(product),
    sku: safeText(product.modelCode || product.supplierSymbol || product.supplierProductId),
    price: normalizeMoneyText(product.salePriceUah),
    store: "CINQ",
  };
}

function buildSeoFromTemplate(template: TemplateSeoValue, values: Record<string, unknown>): ShopifySeoValue {
  return {
    title: truncateText(renderTemplate(template.titleTemplate, values), SEO_TITLE_MAX),
    description: truncateText(renderTemplate(template.descriptionTemplate, values), SEO_DESCRIPTION_MAX),
  };
}

function readTemplateSeo(formData: FormData, prefix: string): TemplateSeoValue {
  return {
    titleTemplate: safeText(formData.get(`${prefix}TitleTemplate`)),
    descriptionTemplate: safeText(formData.get(`${prefix}DescriptionTemplate`)),
  };
}

function defaultShopifySeoTitleTemplate() {
  return "{vendor} {nameType} {sku} — купити в Україні | CINQ";
}

function defaultShopifySeoDescriptionTemplate() {
  return "Оригінальний {vendor} {nameType} {sku} у CINQ. Актуальна наявність, допомога з розміром і доставка по Україні.";
}

function defaultParserVoSeoTitleTemplate() {
  return "{brand} {color} {nameType} {sku} — купити в Україні | CINQ";
}

function defaultParserVoSeoDescriptionTemplate() {
  return "Оригінальний {brand} {color} {nameType} у CINQ. Ціна {price} грн. Доставка по Україні, допомога з розміром та перевірені постачальники.";
}

function buildTemplatePreviewRow(product: ShopifyStoreProduct, seo: ShopifySeoValue): BulkReplacePreviewRow {
  return {
    id: product.id,
    title: product.title,
    sku: safeText(firstShopifyVariant(product).sku || product.handle || legacyIdFromGid(product.id)),
    brandBefore: product.vendor,
    brandAfter: seo.title,
    changedFields: [`SEO title ${seo.title.length}/${SEO_TITLE_MAX}`, `Meta description ${seo.description.length}/${SEO_DESCRIPTION_MAX}`],
  };
}

async function applyShopifyStoreWideSeoTemplate(
  admin: AdminClient,
  shop: string,
  products: ShopifyStoreProduct[],
  template: TemplateSeoValue,
  targetVendor?: string,
) {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const processedIds: string[] = [];

  for (const product of products) {
    processedIds.push(product.id);
    try {
      const seo = buildSeoFromTemplate(template, shopifyTemplateValues(product, targetVendor));
      if (product.seo?.title === seo.title && product.seo?.description === seo.description) {
        skipped += 1;
        continue;
      }
      await updateShopifyProductSeo(admin, product.id, seo);
      updated += 1;
      await db.syncLog.create({
        data: {
          shop,
          status: "shopify_store_template_seo_synced",
          message: `Shopify-wide SEO template updated: ${product.title}`,
        },
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.title}: ${message}`);
      await db.syncLog.create({
        data: {
          shop,
          status: "shopify_store_template_seo_error",
          message: `Shopify-wide SEO template failed: ${product.title} — ${message.slice(0, 380)}`,
          errorMessage: message,
        },
      });
    }
  }

  return { total: products.length, updated, skipped, failed, errors, processedIds };
}

async function applyShopifyStoreWideFields(
  admin: AdminClient,
  shop: string,
  products: ShopifyStoreProduct[],
  options: { vendor?: string; productType?: string; nameType?: string; oldTitleText?: string; newTitleText?: string },
) {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const processedIds: string[] = [];

  for (const product of products) {
    processedIds.push(product.id);
    const changedFields: string[] = [];
    try {
      const input: Record<string, unknown> = { id: product.id };
      const nextVendor = safeText(options.vendor);
      const nextType = safeText(options.productType);
      if (nextVendor && safeText(product.vendor) !== nextVendor) {
        input.vendor = nextVendor;
        changedFields.push("Shopify vendor");
      }
      if (nextType && safeText(product.productType) !== nextType) {
        input.productType = nextType;
        changedFields.push("Shopify product type");
      }
      const nextNameType = safeText(options.nameType);
      if (nextNameType && safeText(product.nameTypeMetafield?.value) !== nextNameType) {
        input.metafields = [
          {
            namespace: "custom",
            key: "name_type",
            type: "single_line_text_field",
            value: nextNameType,
          },
        ];
        changedFields.push("custom.name_type");
      }
      const oldTitleText = safeText(options.oldTitleText);
      const newTitleText = safeText(options.newTitleText);
      if (oldTitleText && newTitleText) {
        const nextTitle = replaceTextBlock(product.title, oldTitleText, newTitleText);
        if (hasTextChanged(product.title, nextTitle)) {
          input.title = nextTitle;
          changedFields.push("Shopify title");
        }
      }
      if (Object.keys(input).length > 1) {
        await updateShopifyProductFields(admin, input);
        updated += 1;
        await db.syncLog.create({ data: { shop, status: "shopify_store_fields_synced", message: `Shopify fields updated: ${product.title} (${changedFields.join(", ")})` } });
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.title}: ${message}`);
      await db.syncLog.create({ data: { shop, status: "shopify_store_fields_error", message: `Shopify fields update failed: ${product.title} — ${message.slice(0, 380)}`, errorMessage: message } });
    }
  }

  return { total: products.length, updated, skipped, failed, errors, processedIds };
}

function buildStoreWidePreview(product: ShopifyStoreProduct, oldText: string, targetBrand: string, fields: StoreWideNormalizeFields): BulkReplacePreviewRow {
  const changedFields: string[] = [];
  if (fields.shopifyVendor && safeText(product.vendor) !== safeText(targetBrand)) changedFields.push("Shopify vendor");
  if (fields.replaceProductTitle && hasTextChanged(product.title, replaceTextBlock(product.title, oldText, targetBrand))) changedFields.push("Shopify product title");
  if (fields.regenerateSeo) changedFields.push("Generated Shopify SEO");

  return {
    id: product.id,
    title: product.title,
    sku: safeText(firstShopifyVariant(product).sku || product.handle || legacyIdFromGid(product.id)),
    brandBefore: product.vendor,
    brandAfter: targetBrand,
    changedFields,
  };
}

async function applyShopifyStoreWideNormalization(
  admin: AdminClient,
  shop: string,
  products: ShopifyStoreProduct[],
  oldText: string,
  targetBrand: string,
  fields: StoreWideNormalizeFields,
) {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const processedIds: string[] = [];
  const cleanTargetBrand = safeText(targetBrand);

  for (const product of products) {
    processedIds.push(product.id);
    const changedFields: string[] = [];
    try {
      if (!cleanTargetBrand) throw new Error("Target brand is empty.");
      const input: Record<string, unknown> = { id: product.id };

      if (fields.shopifyVendor && safeText(product.vendor) !== cleanTargetBrand) {
        input.vendor = cleanTargetBrand;
        changedFields.push("Shopify vendor");
      }

      if (fields.replaceProductTitle) {
        const nextTitle = replaceTextBlock(product.title, oldText, cleanTargetBrand);
        if (hasTextChanged(product.title, nextTitle)) {
          input.title = nextTitle;
          changedFields.push("Shopify product title");
        }
      }

      if (fields.regenerateSeo) {
        input.seo = buildGeneratedSeoFromShopifyProduct(product, cleanTargetBrand);
        changedFields.push("Generated SEO");
      }

      if (Object.keys(input).length > 1) {
        await updateShopifyProductFields(admin, input);
      }

      if (changedFields.length) {
        updated += 1;
        await db.syncLog.create({
          data: {
            shop,
            status: "shopify_store_seo_synced",
            message: `Shopify store-wide update → '${cleanTargetBrand}': ${product.title} (${changedFields.join(", ")})`,
          },
        });
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.title}: ${message}`);
      await db.syncLog.create({
        data: {
          shop,
          status: "shopify_store_seo_error",
          message: `Shopify store-wide update failed: ${product.title} — ${message.slice(0, 380)}`,
          errorMessage: message,
        },
      });
    }
  }

  return { total: products.length, updated, skipped, failed, errors, processedIds };
}


async function applyParserVoSeoTemplate(admin: AdminClient, shop: string, products: any[], template: TemplateSeoValue) {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const processedIds: string[] = [];

  for (const product of products) {
    processedIds.push(product.id);
    try {
      if (!product.shopifyProductGid) throw new Error("Product is not linked to Shopify.");
      const seo = buildSeoFromTemplate(template, parserVoTemplateValues(product));
      await updateShopifyProductSeo(admin, product.shopifyProductGid, seo);
      updated += 1;
      await db.syncLog.create({ data: { shop, importedProductId: product.id, supplierName: product.supplierName, supplierUrl: product.supplierUrl, status: "parservo_template_seo_synced", message: `ParserVo SEO template updated: ${seo.title}` } });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.originalTitle || product.title}: ${message}`);
      await db.syncLog.create({ data: { shop, importedProductId: product.id, supplierName: product.supplierName, supplierUrl: product.supplierUrl, status: "parservo_template_seo_error", message: `ParserVo SEO template failed: ${message.slice(0, 450)}`, errorMessage: message } });
    }
  }

  return { total: products.length, updated, skipped, failed, errors, processedIds };
}

async function updateGeneratedSeoForProducts(admin: AdminClient, shop: string, products: any[]) {
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const product of products) {
    try {
      if (!product.shopifyProductGid) throw new Error("Product is not linked to Shopify.");
      const seo = buildGeneratedSeo(product);
      await updateShopifyProductSeo(admin, product.shopifyProductGid, seo);
      updated += 1;
      await db.syncLog.create({
        data: {
          shop,
          importedProductId: product.id,
          supplierName: product.supplierName,
          supplierUrl: product.supplierUrl,
          status: "shopify_seo_synced",
          message: `SEO updated: ${seo.title}`,
        },
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.originalTitle || product.title}: ${message}`);
      await db.syncLog.create({
        data: {
          shop,
          importedProductId: product.id,
          supplierName: product.supplierName,
          supplierUrl: product.supplierUrl,
          status: "shopify_seo_sync_error",
          message: `SEO update failed: ${message.slice(0, 450)}`,
          errorMessage: message,
        },
      });
    }
  }

  return { total: products.length, updated, failed, errors };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = parsePage(url.searchParams.get("page"));
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));
  const filters = readSeoFilters(url);
  const where = buildSeoWhere(session.shop, filters);

  const [products, filteredTotal, linkedTotal, brandRows] = await Promise.all([
    db.importedProduct.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.importedProduct.count({ where }),
    db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null } } }),
    db.importedProduct.findMany({
      where: { shop: session.shop, shopifyProductGid: { not: null } },
      distinct: ["brand"],
      select: { brand: true },
      orderBy: { brand: "asc" },
    }),
  ]);

  const shopifySeoMap = await fetchShopifySeoMap(admin, products.map((product: any) => product.shopifyProductGid));
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));

  const rows = products.map((product: any) => {
    const generated = buildGeneratedSeo(product);
    const current = shopifySeoMap.get(product.shopifyProductGid) || { title: "", description: "" };
    const status = seoStatus(generated, current);
    return {
      product,
      generated,
      current,
      status,
      shopifyAdminUrl: product.shopifyProductId
        ? `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/products/${product.shopifyProductId}`
        : product.shopifyProductGid
          ? `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/products/${legacyIdFromGid(product.shopifyProductGid)}`
          : "",
    };
  });

  return {
    rows,
    filters,
    pageSize,
    pagination: {
      page: safePage,
      pageSize,
      totalPages,
      filteredTotal,
      linkedTotal,
      from: filteredTotal === 0 ? 0 : (safePage - 1) * pageSize + 1,
      to: Math.min(safePage * pageSize, filteredTotal),
    },
    options: {
      brands: brandRows.map((row: any) => row.brand).filter(Boolean),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "preview_shopify_template_seo") {
    const queryText = cleanShopifySearchQuery(formData.get("templateQuery"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("templateLimit") || 10) || 10));
    const targetVendor = safeText(formData.get("templateVendorOverride"));
    const template = readTemplateSeo(formData, "template");
    if (!template.titleTemplate || !template.descriptionTemplate) return { ok: false, error: "Укажи SEO title format и meta description format." };
    const products = await fetchShopifyStoreProducts(admin, queryText, limit);
    if (products.length === 0) return { ok: false, error: "В Shopify не найдено товаров по этому запросу." };
    return {
      ok: true,
      message: `Preview SEO template: найдено ${products.length} товаров Shopify. Проверь пример title/description ниже.`,
      replacePreview: products.map((product) => buildTemplatePreviewRow(product, buildSeoFromTemplate(template, shopifyTemplateValues(product, targetVendor)))),
    };
  }

  if (intent === "auto_shopify_template_seo_tick") {
    const queryText = cleanShopifySearchQuery(formData.get("templateQuery"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("templateLimit") || 10) || 10));
    const targetVendor = safeText(formData.get("templateVendorOverride"));
    const template = readTemplateSeo(formData, "template");
    const afterCursor = safeText(formData.get("shopifyAfterCursor"));
    if (!template.titleTemplate || !template.descriptionTemplate) return { ok: false, autoStoreTick: true, done: true, error: "Укажи SEO title format и meta description format." } as any;

    // Важно: для Shopify-wide SEO используем cursor pagination.
    // Excluded IDs ломают процесс, если первые товары skipped: очередь думает, что товаров больше нет.
    const page = await fetchShopifyStoreProductsPage(admin, queryText, limit, afterCursor || null);
    const products = page.products;
    if (products.length === 0) {
      return { ok: true, autoStoreTick: true, done: true, message: "SEO template update завершен: больше нет товаров по текущему Shopify query.", total: 0, updated: 0, skipped: 0, failed: 0, processedIds: [], errors: [], nextCursor: "" } as any;
    }
    const result = await applyShopifyStoreWideSeoTemplate(admin, session.shop, products, template, targetVendor);
    const hasNextPage = Boolean(page.pageInfo?.hasNextPage);
    return {
      ok: result.failed === 0,
      autoStoreTick: true,
      done: !hasNextPage,
      message: hasNextPage
        ? `SEO template batch finished. Total: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}. Следующая партия запустится автоматически.`
        : `SEO template update завершен. Last batch: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      total: result.total,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      processedIds: result.processedIds,
      errors: result.errors.slice(0, 20),
      nextCursor: page.pageInfo?.endCursor || "",
    } as any;
  }

  if (intent === "preview_shopify_fields") {
    const queryText = cleanShopifySearchQuery(formData.get("fieldsQuery"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("fieldsLimit") || 10) || 10));
    const vendor = safeText(formData.get("fieldsVendor"));
    const productType = safeText(formData.get("fieldsProductType"));
    const nameType = safeText(formData.get("fieldsNameType"));
    const oldTitleText = safeText(formData.get("fieldsOldTitleText"));
    const newTitleText = safeText(formData.get("fieldsNewTitleText"));
    if (!vendor && !productType && !nameType && !(oldTitleText && newTitleText)) return { ok: false, error: "Укажи хотя бы Vendor, Shopify product type, custom.name_type или замену в title." };
    const products = await fetchShopifyStoreProducts(admin, queryText, limit);
    if (products.length === 0) return { ok: false, error: "В Shopify не найдено товаров по этому запросу." };
    return {
      ok: true,
      message: `Preview fields: найдено ${products.length} товаров Shopify.`,
      replacePreview: products.map((product) => ({
        id: product.id,
        title: product.title,
        sku: safeText(firstShopifyVariant(product).sku || product.handle || legacyIdFromGid(product.id)),
        brandBefore: `${product.vendor}${product.productType ? ` / ${product.productType}` : ""}${product.nameTypeMetafield?.value ? ` / name_type: ${product.nameTypeMetafield.value}` : ""}`,
        brandAfter: `${vendor || product.vendor}${productType ? ` / ${productType}` : product.productType ? ` / ${product.productType}` : ""}${nameType ? ` / name_type: ${nameType}` : product.nameTypeMetafield?.value ? ` / name_type: ${product.nameTypeMetafield.value}` : ""}`,
        changedFields: [vendor ? "Vendor" : "", productType ? "Product type" : "", nameType ? "custom.name_type" : "", oldTitleText && newTitleText ? "Title replace" : ""].filter(Boolean),
      })),
    };
  }

  if (intent === "auto_shopify_fields_tick") {
    const queryText = cleanShopifySearchQuery(formData.get("fieldsQuery"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("fieldsLimit") || 10) || 10));
    const afterCursor = safeText(formData.get("shopifyAfterCursor"));
    const options = {
      vendor: safeText(formData.get("fieldsVendor")),
      productType: safeText(formData.get("fieldsProductType")),
      nameType: safeText(formData.get("fieldsNameType")),
      oldTitleText: safeText(formData.get("fieldsOldTitleText")),
      newTitleText: safeText(formData.get("fieldsNewTitleText")),
    };
    if (!options.vendor && !options.productType && !options.nameType && !(options.oldTitleText && options.newTitleText)) return { ok: false, autoStoreTick: true, done: true, error: "Укажи хотя бы Vendor, Shopify product type, custom.name_type или замену в title." } as any;

    const page = await fetchShopifyStoreProductsPage(admin, queryText, limit, afterCursor || null);
    const products = page.products;
    if (products.length === 0) {
      return { ok: true, autoStoreTick: true, done: true, message: "Shopify fields update завершен: больше нет товаров по текущему Shopify query.", total: 0, updated: 0, skipped: 0, failed: 0, processedIds: [], errors: [], nextCursor: "" } as any;
    }
    const result = await applyShopifyStoreWideFields(admin, session.shop, products, options);
    const hasNextPage = Boolean(page.pageInfo?.hasNextPage);
    return {
      ok: result.failed === 0,
      autoStoreTick: true,
      done: !hasNextPage,
      message: hasNextPage
        ? `Shopify fields batch finished. Total: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}. Следующая партия запустится автоматически.`
        : `Shopify fields update завершен. Last batch: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      total: result.total,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      processedIds: result.processedIds,
      errors: result.errors.slice(0, 20),
      nextCursor: page.pageInfo?.endCursor || "",
    } as any;
  }

  if (intent === "preview_parservo_template_seo") {
    const limit = Math.max(1, Math.min(50, Number(formData.get("parservoTemplateLimit") || 10) || 10));
    const template = readTemplateSeo(formData, "parservoTemplate");
    const filters = readSeoFilters(url);
    if (!template.titleTemplate || !template.descriptionTemplate) return { ok: false, error: "Укажи SEO title format и meta description format для ParserVo товаров." };
    const products = await db.importedProduct.findMany({ where: buildSeoWhere(session.shop, filters), orderBy: { createdAt: "desc" }, take: limit });
    if (products.length === 0) return { ok: false, error: "По текущим фильтрам ParserVo товары не найдены." };
    return {
      ok: true,
      message: `Preview ParserVo SEO template: найдено ${products.length} товаров.`,
      replacePreview: products.map((product: any) => {
        const seo = buildSeoFromTemplate(template, parserVoTemplateValues(product));
        return { id: product.id, title: safeText(product.originalTitle || product.title), sku: safeText(product.supplierSymbol || product.modelCode || product.supplierProductId), brandBefore: safeText(product.brand), brandAfter: seo.title, changedFields: [`SEO title ${seo.title.length}/${SEO_TITLE_MAX}`, `Meta description ${seo.description.length}/${SEO_DESCRIPTION_MAX}`] };
      }),
    };
  }

  if (intent === "auto_parservo_template_seo_tick") {
    const limit = Math.max(1, Math.min(50, Number(formData.get("parservoTemplateLimit") || 10) || 10));
    const template = readTemplateSeo(formData, "parservoTemplate");
    const filters = readSeoFilters(url);
    const excludedIds = getExcludedIdsFromForm(formData);
    if (!template.titleTemplate || !template.descriptionTemplate) return { ok: false, autoStoreTick: true, done: true, error: "Укажи SEO title format и meta description format для ParserVo товаров." } as any;
    const parserVoWhere: any = buildSeoWhere(session.shop, filters);
    if (excludedIds.length) {
      parserVoWhere.AND = Array.isArray(parserVoWhere.AND) ? parserVoWhere.AND : [parserVoWhere];
      parserVoWhere.AND.push({ id: { notIn: excludedIds } });
    }
    const products = await db.importedProduct.findMany({ where: parserVoWhere, orderBy: { createdAt: "desc" }, take: limit });
    if (products.length === 0) return { ok: true, autoStoreTick: true, done: true, message: "ParserVo SEO template update завершен: больше нет товаров по текущим фильтрам.", total: 0, updated: 0, skipped: 0, failed: 0, processedIds: [], errors: [] } as any;
    const result = await applyParserVoSeoTemplate(admin, session.shop, products, template);
    return { ok: result.failed === 0, autoStoreTick: true, done: false, message: `ParserVo SEO template batch finished. Total: ${result.total}. Updated: ${result.updated}. Failed: ${result.failed}.`, total: result.total, updated: result.updated, skipped: result.skipped, failed: result.failed, processedIds: result.processedIds, errors: result.errors.slice(0, 20) } as any;
  }

  if (intent === "preview_shopify_store_brand") {
    const oldText = safeText(formData.get("storeOldText"));
    const targetBrand = safeText(formData.get("storeTargetBrand"));
    const queryText = cleanShopifySearchQuery(formData.get("storeQuery") || oldText);
    const limit = Math.max(1, Math.min(50, Number(formData.get("storeLimit") || 10) || 10));
    const fields = readStoreWideFields(formData);

    if (!queryText) return { ok: false, error: "Укажи Shopify search query или старый бренд." };
    if (!targetBrand) return { ok: false, error: "Укажи новый бренд, например Ami Paris." };
    if (!fields.shopifyVendor && !fields.regenerateSeo && !fields.replaceProductTitle) {
      return { ok: false, error: "Выбери хотя бы одно действие: Shopify vendor / Regenerate SEO / Product title." };
    }

    const products = await fetchShopifyStoreProducts(admin, queryText, limit);
    if (products.length === 0) return { ok: false, error: "В Shopify не найдено товаров по этому запросу." };

    return {
      ok: true,
      message: `Preview Shopify store-wide: найдено ${products.length} товаров. Если список верный — запускай Start automatic Shopify-wide update.`,
      replacePreview: products.map((product) => buildStoreWidePreview(product, oldText || queryText, targetBrand, fields)),
    };
  }

  if (intent === "auto_shopify_store_brand_tick") {
    const oldText = safeText(formData.get("storeOldText"));
    const targetBrand = safeText(formData.get("storeTargetBrand"));
    const queryText = cleanShopifySearchQuery(formData.get("storeQuery") || oldText);
    const limit = Math.max(1, Math.min(50, Number(formData.get("storeLimit") || 10) || 10));
    const fields = readStoreWideFields(formData);
    const excludedIds = getExcludedIdsFromForm(formData);

    if (!queryText) return { ok: false, autoStoreTick: true, done: true, error: "Укажи Shopify search query или старый бренд." } as any;
    if (!targetBrand) return { ok: false, autoStoreTick: true, done: true, error: "Укажи новый бренд, например Ami Paris." } as any;
    if (!fields.shopifyVendor && !fields.regenerateSeo && !fields.replaceProductTitle) {
      return { ok: false, autoStoreTick: true, done: true, error: "Выбери хотя бы одно действие: Shopify vendor / Regenerate SEO / Product title." } as any;
    }

    const fetched = await fetchShopifyStoreProducts(admin, queryText, Math.min(50, limit + excludedIds.length));
    const products = fetched.filter((product) => !excludedIds.includes(product.id)).slice(0, limit);

    if (products.length === 0) {
      return {
        ok: true,
        autoStoreTick: true,
        done: true,
        message: "Shopify-wide обновление завершено: больше нет товаров по текущему запросу.",
        total: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        processedIds: [],
        errors: [],
      } as any;
    }

    const result = await applyShopifyStoreWideNormalization(admin, session.shop, products, oldText || queryText, targetBrand, fields);
    return {
      ok: result.failed === 0,
      autoStoreTick: true,
      done: false,
      message: `Shopify-wide batch finished. Total: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      total: result.total,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      processedIds: result.processedIds,
      errors: result.errors.slice(0, 20),
    } as any;
  }

  if (intent === "auto_brand_normalize_tick") {
    const fromBrand = safeText(formData.get("fromBrand"));
    const targetBrand = safeText(formData.get("targetBrand"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("brandNormalizeLimit") || 10) || 10));
    const fields = readBrandNormalizeFields(formData);
    const excludedIds = getExcludedIdsFromForm(formData);
    const filters = readSeoFilters(url);

    if (!targetBrand) return { ok: false, autoBrandTick: true, done: true, error: "Укажи новый бренд, например Ami Paris." };
    if (!fields.parservoBrand && !fields.shopifyVendor && !fields.regenerateSeo) {
      return { ok: false, autoBrandTick: true, done: true, error: "Выбери хотя бы одно действие: ParserVo brand / Shopify vendor / Regenerate SEO." };
    }

    const products = await db.importedProduct.findMany({
      where: buildBrandNormalizeWhere(session.shop, filters, fromBrand, targetBrand, excludedIds),
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    if (products.length === 0) {
      return {
        ok: true,
        autoBrandTick: true,
        done: true,
        message: "Автоматическая нормализация бренда завершена: больше нет товаров по текущим фильтрам.",
        total: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        processedIds: [],
        errors: [],
      };
    }

    const result = await applyBrandNormalization(admin, session.shop, products, targetBrand, fields);
    return {
      ok: result.failed === 0,
      autoBrandTick: true,
      done: false,
      message: `Brand normalization batch finished. Total: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      total: result.total,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      processedIds: result.processedIds,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "preview_brand_normalize") {
    const fromBrand = safeText(formData.get("fromBrand"));
    const targetBrand = safeText(formData.get("targetBrand"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("brandNormalizeLimit") || 10) || 10));
    const filters = readSeoFilters(url);
    if (!targetBrand) return { ok: false, error: "Укажи новый бренд, например Ami Paris." };

    const products = await db.importedProduct.findMany({
      where: buildBrandNormalizeWhere(session.shop, filters, fromBrand, targetBrand),
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    if (products.length === 0) return { ok: false, error: "По текущим фильтрам товары для нормализации бренда не найдены." };

    return {
      ok: true,
      message: `Preview brand normalization: найдено ${products.length} товаров. Если список верный — запускай Start automatic brand normalization.`,
      replacePreview: products.map((product: any) => ({
        id: product.id,
        title: safeText(product.originalTitle || product.title),
        sku: safeText(product.supplierSymbol || product.modelCode || product.supplierProductId),
        brandBefore: safeText(product.brand),
        brandAfter: targetBrand,
        changedFields: ["ParserVo brand", "Shopify vendor", "Generated SEO"],
      })),
    };
  }

  if (intent === "update_single_manual") {
    const productId = String(formData.get("productId") || "");
    const seoTitle = truncateText(String(formData.get("seoTitle") || ""), SEO_TITLE_MAX);
    const seoDescription = truncateText(String(formData.get("seoDescription") || ""), SEO_DESCRIPTION_MAX);
    const product = await db.importedProduct.findFirst({ where: { id: productId, shop: session.shop, shopifyProductGid: { not: null } } });
    if (!product) return { ok: false, error: "Товар не найден или не создан в Shopify." };

    await updateShopifyProductSeo(admin, product.shopifyProductGid, { title: seoTitle, description: seoDescription });
    await db.syncLog.create({
      data: {
        shop: session.shop,
        importedProductId: product.id,
        supplierName: product.supplierName,
        supplierUrl: product.supplierUrl,
        status: "shopify_seo_manual_updated",
        message: `Manual SEO updated: ${seoTitle}`,
      },
    });
    return { ok: true, message: `SEO обновлено вручную: ${product.originalTitle || product.title}` };
  }

  if (intent === "update_selected_generated" || intent === "update_page_generated") {
    const ids = intent === "update_selected_generated"
      ? getIdsFromForm(formData, "selectedProductIds")
      : getIdsFromForm(formData, "pageProductIds");

    if (ids.length === 0) return { ok: false, error: "Нет выбранных товаров." };

    const products = await db.importedProduct.findMany({
      where: { shop: session.shop, id: { in: ids }, shopifyProductGid: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    const result = await updateGeneratedSeoForProducts(admin, session.shop, products.slice(0, 50));
    return {
      ok: result.failed === 0,
      message: `SEO generated. Total: ${result.total}. Updated: ${result.updated}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "update_next_filtered_generated") {
    const limit = Math.max(1, Math.min(50, Number(formData.get("limit") || 20) || 20));
    const filters = readSeoFilters(url);
    const products = await db.importedProduct.findMany({
      where: buildSeoWhere(session.shop, filters),
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    const result = await updateGeneratedSeoForProducts(admin, session.shop, products);
    return {
      ok: result.failed === 0,
      message: `SEO batch finished. Total: ${result.total}. Updated: ${result.updated}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "auto_bulk_replace_tick") {
    const findText = safeText(formData.get("findText"));
    const replaceWith = safeText(formData.get("replaceWith"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("replaceLimit") || 10) || 10));
    const fields = readReplaceFields(formData);
    const excludedIds = getExcludedIdsFromForm(formData);

    if (!findText) return { ok: false, autoReplaceTick: true, done: true, error: "Укажи текст, который нужно заменить." };
    if (!replaceWith) return { ok: false, autoReplaceTick: true, done: true, error: "Укажи новый текст." };
    if (fields.size === 0) return { ok: false, autoReplaceTick: true, done: true, error: "Выбери хотя бы один блок для замены." };

    const filters = readSeoFilters(url);
    const where: any = buildBulkReplaceWhere(session.shop, filters, findText);
    if (excludedIds.length) {
      where.AND = Array.isArray(where.AND) ? where.AND : [where];
      where.AND.push({ id: { notIn: excludedIds } });
    }

    const products = await db.importedProduct.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    if (products.length === 0) {
      return {
        ok: true,
        autoReplaceTick: true,
        done: true,
        message: "Автоматическая замена завершена: больше нет товаров по текущим фильтрам.",
        total: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        processedIds: [],
        errors: [],
      };
    }

    const result = await applyBulkReplace(admin, session.shop, products, findText, replaceWith, fields);
    return {
      ok: result.failed === 0,
      autoReplaceTick: true,
      done: false,
      message: `Auto batch finished. Total: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      total: result.total,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      processedIds: result.processedIds,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "preview_bulk_replace" || intent === "apply_bulk_replace") {
    const findText = safeText(formData.get("findText"));
    const replaceWith = safeText(formData.get("replaceWith"));
    const limit = Math.max(1, Math.min(50, Number(formData.get("replaceLimit") || 20) || 20));
    const fields = readReplaceFields(formData);

    if (!findText) return { ok: false, error: "Укажи текст, который нужно заменить." };
    if (!replaceWith) return { ok: false, error: "Укажи новый текст." };
    if (fields.size === 0) return { ok: false, error: "Выбери хотя бы один блок для замены." };

    const filters = readSeoFilters(url);
    const products = await db.importedProduct.findMany({
      where: buildBulkReplaceWhere(session.shop, filters, findText),
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    if (products.length === 0) return { ok: false, error: "По текущим фильтрам товары для замены не найдены." };

    if (intent === "preview_bulk_replace") {
      const seoMap = await fetchShopifySeoMap(admin, products.map((product: any) => product.shopifyProductGid));
      const previewRows = products.map((product: any) => buildBulkReplacePreview(product, seoMap.get(product.shopifyProductGid), findText, replaceWith, fields));
      return {
        ok: true,
        message: `Preview: найдено ${products.length} товаров. Проверь список ниже перед массовым обновлением.`,
        replacePreview: previewRows,
      };
    }

    const result = await applyBulkReplace(admin, session.shop, products, findText, replaceWith, fields);
    return {
      ok: result.failed === 0,
      message: `Bulk replace finished. Total: ${result.total}. Updated: ${result.updated}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  return { ok: false, error: "Unknown SEO action." };
};

type ActionData = {
  ok?: boolean;
  message?: string;
  error?: string;
  errors?: string[];
  replacePreview?: BulkReplacePreviewRow[];
  autoReplaceTick?: boolean;
  autoBrandTick?: boolean;
  autoStoreTick?: boolean;
  done?: boolean;
  total?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  processedIds?: string[];
  nextCursor?: string;
};

function hiddenPageProducts(rows: any[]) {
  return rows.map((row) => <input key={row.product.id} type="hidden" name="pageProductIds" value={row.product.id} />);
}

export default function SeoCenter() {
  const { rows, filters: loaderFilters, options, pagination, pageSize } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const isBusy = navigation.state !== "idle";
  const [filters, setFilters] = useState<SeoFilters>(loaderFilters || { q: "", brand: "all", audit: "all" });
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const autoReplaceFetcher = useFetcher<ActionData>();
  const autoReplaceRunningRef = useRef(false);
  const autoReplaceTimerRef = useRef<number | null>(null);
  const [autoReplace, setAutoReplace] = useState({
    running: false,
    processedIds: [] as string[],
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    lastMessage: "",
    error: "",
  });

  const autoBrandFetcher = useFetcher<ActionData>();
  const autoBrandRunningRef = useRef(false);
  const autoBrandTimerRef = useRef<number | null>(null);
  const [autoBrand, setAutoBrand] = useState({
    running: false,
    processedIds: [] as string[],
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    lastMessage: "",
    error: "",
  });


  const autoStoreFetcher = useFetcher<ActionData>();
  const autoStoreFormClassRef = useRef(".shopify-template-seo-form");
  const autoStoreRunningRef = useRef(false);
  const autoStoreTimerRef = useRef<number | null>(null);
  const [autoStore, setAutoStore] = useState({
    running: false,
    processedIds: [] as string[],
    nextCursor: "",
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    lastMessage: "",
    error: "",
  });

  useEffect(() => {
    setFilters(loaderFilters || { q: "", brand: "all", audit: "all" });
    setSelectedIds({});
  }, [loaderFilters, pagination.page, pageSize]);

  const visibleRows = useMemo(() => {
    if (filters.audit === "all") return rows;
    return rows.filter((row: any) => {
      if (filters.audit === "missing") return !row.current.title && !row.current.description;
      if (filters.audit === "needs_update") return row.current.title !== row.generated.title || row.current.description !== row.generated.description;
      if (filters.audit === "title_long") return row.generated.title.length > SEO_TITLE_MAX;
      if (filters.audit === "description_long") return row.generated.description.length > SEO_DESCRIPTION_MAX;
      if (filters.audit === "ok") return row.current.title === row.generated.title && row.current.description === row.generated.description;
      return true;
    });
  }, [rows, filters.audit]);

  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  useEffect(() => {
    autoReplaceRunningRef.current = autoReplace.running;
  }, [autoReplace.running]);


  useEffect(() => {
    autoBrandRunningRef.current = autoBrand.running;
  }, [autoBrand.running]);

  useEffect(() => {
    autoStoreRunningRef.current = autoStore.running;
  }, [autoStore.running]);

  useEffect(() => {
    return () => {
      if (autoReplaceTimerRef.current) window.clearTimeout(autoReplaceTimerRef.current);
      if (autoBrandTimerRef.current) window.clearTimeout(autoBrandTimerRef.current);
      if (autoStoreTimerRef.current) window.clearTimeout(autoStoreTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const data = autoReplaceFetcher.data as ActionData | undefined;
    if (!data?.autoReplaceTick) return;

    setAutoReplace((current) => {
      const processedIds = Array.from(new Set([
        ...current.processedIds,
        ...(data.processedIds || []),
      ]));
      const next = {
        ...current,
        processedIds,
        processed: current.processed + Number(data.total || 0),
        updated: current.updated + Number(data.updated || 0),
        skipped: current.skipped + Number(data.skipped || 0),
        failed: current.failed + Number(data.failed || 0),
        lastMessage: data.message || current.lastMessage,
        error: data.error || (data.errors?.length ? data.errors.join("\n") : ""),
        running: Boolean(autoReplaceRunningRef.current && !data.done && !data.error),
      };

      if (next.running) {
        autoReplaceTimerRef.current = window.setTimeout(() => {
          if (autoReplaceRunningRef.current) submitAutoReplaceTick(processedIds);
        }, 850);
      }

      return next;
    });
  }, [autoReplaceFetcher.data]);

  useEffect(() => {
    const data = autoBrandFetcher.data as ActionData | undefined;
    if (!data?.autoBrandTick) return;

    setAutoBrand((current) => {
      const processedIds = Array.from(new Set([
        ...current.processedIds,
        ...(data.processedIds || []),
      ]));
      const next = {
        ...current,
        processedIds,
        processed: current.processed + Number(data.total || 0),
        updated: current.updated + Number(data.updated || 0),
        skipped: current.skipped + Number(data.skipped || 0),
        failed: current.failed + Number(data.failed || 0),
        lastMessage: data.message || current.lastMessage,
        error: data.error || (data.errors?.length ? data.errors.join("\n") : ""),
        running: Boolean(autoBrandRunningRef.current && !data.done && !data.error),
      };

      if (next.running) {
        autoBrandTimerRef.current = window.setTimeout(() => {
          if (autoBrandRunningRef.current) submitAutoBrandTick(processedIds);
        }, 850);
      }

      return next;
    });
  }, [autoBrandFetcher.data]);


  useEffect(() => {
    const data = autoStoreFetcher.data as ActionData | undefined;
    if (!data?.autoStoreTick) return;

    setAutoStore((current) => {
      const processedIds = Array.from(new Set([
        ...current.processedIds,
        ...(data.processedIds || []),
      ]));
      const nextCursor = typeof data.nextCursor === "string" ? data.nextCursor : current.nextCursor;
      const next = {
        ...current,
        processedIds,
        nextCursor,
        processed: current.processed + Number(data.total || 0),
        updated: current.updated + Number(data.updated || 0),
        skipped: current.skipped + Number(data.skipped || 0),
        failed: current.failed + Number(data.failed || 0),
        lastMessage: data.message || current.lastMessage,
        error: data.error || (data.errors?.length ? data.errors.join("\n") : ""),
        running: Boolean(autoStoreRunningRef.current && !data.done && !data.error),
      };

      if (next.running) {
        autoStoreTimerRef.current = window.setTimeout(() => {
          if (autoStoreRunningRef.current) submitAutoStoreTick(processedIds, nextCursor);
        }, 900);
      }

      return next;
    });
  }, [autoStoreFetcher.data]);

  function buildAutoReplaceFormData(excludedIds: string[]) {
    const form = document.querySelector<HTMLFormElement>(".bulk-replace-form");
    const formData = new FormData(form || undefined);
    formData.set("intent", "auto_bulk_replace_tick");
    formData.delete("excludedProductIds");
    for (const id of excludedIds) formData.append("excludedProductIds", id);
    return formData;
  }

  function submitAutoReplaceTick(excludedIds: string[]) {
    autoReplaceFetcher.submit(buildAutoReplaceFormData(excludedIds), {
      method: "post",
      action: `${location.pathname}${location.search}`,
    });
  }

  function startAutoReplace() {
    if (autoReplaceFetcher.state !== "idle") return;
    if (autoReplaceTimerRef.current) window.clearTimeout(autoReplaceTimerRef.current);
    autoReplaceRunningRef.current = true;
    setAutoReplace({
      running: true,
      processedIds: [],
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      lastMessage: "Автоматическая замена запущена. Можно оставаться на странице SEO Center и не нажимать batch вручную.",
      error: "",
    });
    submitAutoReplaceTick([]);
  }

  function stopAutoReplace() {
    autoReplaceRunningRef.current = false;
    if (autoReplaceTimerRef.current) window.clearTimeout(autoReplaceTimerRef.current);
    setAutoReplace((current) => ({ ...current, running: false, lastMessage: "Автоматическая замена остановлена вручную." }));
  }


  function buildAutoBrandFormData(excludedIds: string[]) {
    const form = document.querySelector<HTMLFormElement>(".brand-normalization-form");
    const formData = new FormData(form || undefined);
    formData.set("intent", "auto_brand_normalize_tick");
    formData.delete("excludedProductIds");
    for (const id of excludedIds) formData.append("excludedProductIds", id);
    return formData;
  }

  function submitAutoBrandTick(excludedIds: string[]) {
    autoBrandFetcher.submit(buildAutoBrandFormData(excludedIds), {
      method: "post",
      action: `${location.pathname}${location.search}`,
    });
  }

  function startAutoBrand() {
    if (autoBrandFetcher.state !== "idle") return;
    if (autoBrandTimerRef.current) window.clearTimeout(autoBrandTimerRef.current);
    autoBrandRunningRef.current = true;
    setAutoBrand({
      running: true,
      processedIds: [],
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      lastMessage: "Нормализация бренда запущена. Vendor в Shopify будет принудительно установлен, а SEO можно сразу пересоздать.",
      error: "",
    });
    submitAutoBrandTick([]);
  }

  function stopAutoBrand() {
    autoBrandRunningRef.current = false;
    if (autoBrandTimerRef.current) window.clearTimeout(autoBrandTimerRef.current);
    setAutoBrand((current) => ({ ...current, running: false, lastMessage: "Нормализация бренда остановлена вручную." }));
  }

  function buildAutoStoreFormData(excludedIds: string[], shopifyAfterCursor = "") {
    const form = document.querySelector<HTMLFormElement>(autoStoreFormClassRef.current);
    const formData = new FormData(form || undefined);
    const autoIntent = String(formData.get("autoIntent") || "auto_shopify_template_seo_tick");
    formData.set("intent", autoIntent);
    formData.delete("excludedProductIds");
    formData.delete("shopifyAfterCursor");
    for (const id of excludedIds) formData.append("excludedProductIds", id);
    if (shopifyAfterCursor) formData.set("shopifyAfterCursor", shopifyAfterCursor);
    return formData;
  }

  function submitAutoStoreTick(excludedIds: string[], shopifyAfterCursor = "") {
    autoStoreFetcher.submit(buildAutoStoreFormData(excludedIds, shopifyAfterCursor), {
      method: "post",
      action: `${location.pathname}${location.search}`,
    });
  }

  function startAutoStore(formClass = ".shopify-template-seo-form", message = "Shopify-wide процесс запущен. Он работает со всеми товарами Shopify по выбранному search query.") {
    if (autoStoreFetcher.state !== "idle") return;
    autoStoreFormClassRef.current = formClass;
    if (autoStoreTimerRef.current) window.clearTimeout(autoStoreTimerRef.current);
    autoStoreRunningRef.current = true;
    setAutoStore({
      running: true,
      processedIds: [],
      nextCursor: "",
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      lastMessage: message,
      error: "",
    });
    submitAutoStoreTick([]);
  }

  function stopAutoStore() {
    autoStoreRunningRef.current = false;
    if (autoStoreTimerRef.current) window.clearTimeout(autoStoreTimerRef.current);
    setAutoStore((current) => ({ ...current, running: false, lastMessage: "Shopify-wide обновление остановлено вручную." }));
  }

  function buildFilterParams(nextFilters: SeoFilters, nextPage = 1, nextPageSize = pageSize) {
    const params = new URLSearchParams(location.search);
    for (const key of SEO_FILTER_QUERY_KEYS) params.delete(key);
    params.set("page", String(Math.max(1, nextPage)));
    params.set("pageSize", String(nextPageSize));
    for (const [key, value] of Object.entries(nextFilters)) {
      const clean = safeText(value);
      if (!clean || clean === "all") continue;
      params.set(key, clean);
    }
    return params;
  }

  function applyFilters(nextFilters = filters) {
    navigate(`${location.pathname}?${buildFilterParams(nextFilters, 1, pageSize).toString()}`);
  }

  function pageUrl(nextPage: number, nextPageSize = pageSize) {
    const boundedPage = Math.max(1, Math.min(pagination.totalPages, nextPage));
    return `${location.pathname}?${buildFilterParams(filters, boundedPage, nextPageSize).toString()}`;
  }

  function setRowsSelected(ids: string[], checked = true) {
    setSelectedIds((current) => {
      const next = { ...current };
      for (const id of ids) {
        if (checked) next[id] = true;
        else delete next[id];
      }
      return next;
    });
  }

  return (
    <div className="app-page app-page-wide seo-center-page">
      <div className="app-header">
        <div>
          <h1 className="app-title">SEO Center</h1>
          <p className="app-subtitle">Массовая настройка SEO title и meta description для товаров, которые уже созданы в Shopify.</p>
        </div>
        <div className="button-row">
          <Link className="btn" to={`/app/products${location.search}`}>Imported Products</Link>
          <Link className="btn" to="/app/logs">Sync Logs</Link>
        </div>
      </div>

      {actionData?.message ? <div className={`notice ${actionData.ok ? "notice-success" : "notice-warning"}`}>{actionData.message}</div> : null}
      {actionData?.error ? <div className="notice notice-error">{actionData.error}</div> : null}
      {actionData?.errors?.length ? (
        <div className="notice notice-error">
          <strong>Ошибки:</strong>
          <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{actionData.errors.join("\n")}</pre>
        </div>
      ) : null}

      {actionData?.replacePreview?.length ? (
        <div className="card section-gap bulk-preview-box">
          <strong>Preview / пример изменений:</strong>
          <table className="mini-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU / Handle</th>
                <th>Before</th>
                <th>After / SEO title</th>
                <th>Будет изменено</th>
              </tr>
            </thead>
            <tbody>
              {actionData.replacePreview.map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td>{row.sku || "—"}</td>
                  <td>{row.brandBefore || "—"}</td>
                  <td>{row.brandAfter || "—"}</td>
                  <td>{row.changedFields.length ? row.changedFields.join(", ") : "нет изменений"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid grid-4">
        <div className="card"><div className="metric-label">Linked to Shopify</div><div className="metric-value">{pagination.linkedTotal}</div></div>
        <div className="card"><div className="metric-label">Filtered</div><div className="metric-value">{pagination.filteredTotal}</div></div>
        <div className="card"><div className="metric-label">Page</div><div className="metric-value">{pagination.page} / {pagination.totalPages}</div></div>
        <div className="card"><div className="metric-label">Selected</div><div className="metric-value">{selectedCount}</div></div>
      </div>

      <div className="card section-gap">
        <h2 className="card-title">Filters & SEO review</h2>
        <div className="form-grid seo-filter-grid">
          <div>
            <label>Search</label>
            <input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.currentTarget.value })} onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }} placeholder="title, SKU, brand..." />
          </div>
          <div>
            <label>Brand</label>
            <select value={filters.brand} onChange={(event) => setFilters({ ...filters, brand: event.currentTarget.value })}>
              <option value="all">All</option>
              {options.brands.map((brand: string) => <option key={brand} value={brand}>{brand}</option>)}
            </select>
          </div>
          <div>
            <label>SEO audit</label>
            <select value={filters.audit} onChange={(event) => setFilters({ ...filters, audit: event.currentTarget.value })}>
              <option value="all">All</option>
              <option value="missing">Missing in Shopify</option>
              <option value="needs_update">Needs update</option>
              <option value="ok">SEO OK</option>
              <option value="title_long">Generated title too long</option>
              <option value="description_long">Generated description too long</option>
            </select>
          </div>
          <div>
            <label>Rows</label>
            <select value={pageSize} onChange={(event) => navigate(pageUrl(1, Number(event.currentTarget.value)))}>
              {SEO_PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
        </div>
        <div className="button-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => applyFilters()}>Apply filters</button>
          <Link className="btn" to={location.pathname}>Reset filters</Link>
          <button type="button" className="btn" onClick={() => setRowsSelected(visibleRows.map((row: any) => row.product.id), true)}>Select page</button>
          <button type="button" className="btn" onClick={() => setSelectedIds({})}>Clear selection</button>
        </div>
      </div>

      <div className="seo-mode-grid section-gap">
        <div className="card seo-control-panel seo-control-panel-primary">
          <div className="seo-panel-header">
            <div>
              <h2 className="card-title">1. SEO format для ВСЕХ товаров Shopify</h2>
              <p className="muted small">Работает со всем магазином Shopify, а не только с товарами ParserVo. Можно оставить query пустым — тогда будут обработаны все товары партиями.</p>
            </div>
            <span className="badge badge-green">All Shopify products</span>
          </div>

          <Form method="post" className="shopify-template-seo-form seo-smart-form">
            <input type="hidden" name="autoIntent" value="auto_shopify_template_seo_tick" />
            <div className="form-grid seo-template-grid">
              <div>
                <label>Shopify search query</label>
                <input name="templateQuery" placeholder="Пусто = все товары. Или vendor:'Ami Alexandre Mattiussi' / tag:PreOrder / Ami" />
                <p className="muted small">Для точного Vendor: <code>vendor:'Ami Alexandre Mattiussi'</code>. Для всех товаров оставь поле пустым.</p>
              </div>
              <div>
                <label>Vendor override, если нужно</label>
                <input name="templateVendorOverride" placeholder="Например Ami Paris. Пусто = текущий vendor товара" />
              </div>
              <div>
                <label>Партия</label>
                <select name="templateLimit" defaultValue="10">
                  <option value="10">10 товаров</option>
                  <option value="20">20 товаров</option>
                  <option value="50">50 товаров</option>
                </select>
              </div>
            </div>

            <div className="form-grid seo-template-text-grid">
              <div>
                <label>SEO title format</label>
                <input name="templateTitleTemplate" defaultValue={defaultShopifySeoTitleTemplate()} />
                <p className="muted small">Переменные: <code>{'{vendor}'}</code>, <code>{'{title}'}</code>, <code>{'{name}'}</code>, <code>{'{nameType}'}</code>, <code>{'{name_type}'}</code>, <code>{'{sku}'}</code>, <code>{'{price}'}</code>, <code>{'{color}'}</code>, <code>{'{filter_name}'}</code>, <code>{'{type}'}</code>, <code>{'{handle}'}</code>, <code>{'{store}'}</code></p>
              </div>
              <div>
                <label>Meta description format</label>
                <textarea name="templateDescriptionTemplate" defaultValue={defaultShopifySeoDescriptionTemplate()} />
              </div>
            </div>

            <div className="button-row" style={{ marginTop: 12 }}>
              <button className="btn" type="submit" name="intent" value="preview_shopify_template_seo" disabled={isBusy || autoStore.running}>Preview SEO example</button>
              <button className="btn btn-primary" type="button" onClick={() => startAutoStore(".shopify-template-seo-form", "Shopify-wide SEO template запущен. Можно обработать все товары одинаковым форматом.")} disabled={isBusy || autoStore.running || autoStoreFetcher.state !== "idle"}>Start automatic SEO update</button>
              <button className="btn btn-danger" type="button" onClick={stopAutoStore} disabled={!autoStore.running}>Stop</button>
            </div>
          </Form>
        </div>

        <div className="card seo-control-panel">
          <div className="seo-panel-header">
            <div>
              <h2 className="card-title">2. Vendor / Type / Name type для ВСЕХ товаров Shopify</h2>
              <p className="muted small">Отдельный блок только для Vendor, Shopify product type/category и замены текста в названии товара. SEO тут не трогаем.</p>
            </div>
            <span className="badge badge-yellow">Vendor / Type</span>
          </div>

          <Form method="post" className="shopify-fields-form seo-smart-form">
            <input type="hidden" name="autoIntent" value="auto_shopify_fields_tick" />
            <div className="form-grid seo-template-grid">
              <div>
                <label>Shopify search query</label>
                <input name="fieldsQuery" defaultValue="vendor:'Ami Alexandre Mattiussi'" placeholder="Пусто = все товары. Или vendor:'Ami Alexandre Mattiussi'" />
              </div>
              <div>
                <label>Новый Shopify Vendor</label>
                <input name="fieldsVendor" defaultValue="Ami Paris" placeholder="Ami Paris" />
              </div>
              <div>
                <label>Новый Shopify Type / Category</label>
                <input name="fieldsProductType" placeholder="Футболки / Сумки / Кросівки — необязательно" />
              </div>
              <div>
                <label>Новый Name type / custom.name_type</label>
                <input name="fieldsNameType" placeholder="Футболка / Сумка на плече / Кросівки — необязательно" />
                <p className="muted small">Записывает product metafield <code>custom.name_type</code>. Потом его можно использовать в SEO как <code>{'{nameType}'}</code> или <code>{'{name_type}'}</code>.</p>
              </div>
              <div>
                <label>Партия</label>
                <select name="fieldsLimit" defaultValue="10">
                  <option value="10">10 товаров</option>
                  <option value="20">20 товаров</option>
                  <option value="50">50 товаров</option>
                </select>
              </div>
            </div>
            <div className="form-grid seo-template-grid">
              <div>
                <label>Заменить в product title: старый текст</label>
                <input name="fieldsOldTitleText" placeholder="Ami Alexandre Mattiussi — необязательно" />
              </div>
              <div>
                <label>Заменить в product title: новый текст</label>
                <input name="fieldsNewTitleText" placeholder="Ami Paris — необязательно" />
              </div>
            </div>
            <div className="button-row" style={{ marginTop: 12 }}>
              <button className="btn" type="submit" name="intent" value="preview_shopify_fields" disabled={isBusy || autoStore.running}>Preview fields batch</button>
              <button className="btn btn-primary" type="button" onClick={() => startAutoStore(".shopify-fields-form", "Shopify-wide Vendor / Type update запущен.")} disabled={isBusy || autoStore.running || autoStoreFetcher.state !== "idle"}>Start automatic Vendor / Type update</button>
              <button className="btn btn-danger" type="button" onClick={stopAutoStore} disabled={!autoStore.running}>Stop</button>
            </div>
          </Form>
        </div>
      </div>

      {(autoStore.running || autoStore.processed > 0 || autoStore.lastMessage || autoStore.error) ? (
        <div className={`notice ${autoStore.error ? "notice-error" : autoStore.running ? "notice-warning" : "notice-success"}`} style={{ marginTop: 12 }}>
          <strong>{autoStore.running ? "Shopify-wide process is running" : "Shopify-wide process status"}</strong>
          <div className="small" style={{ marginTop: 6 }}>
            Processed: {autoStore.processed} · Updated: {autoStore.updated} · Skipped: {autoStore.skipped} · Failed: {autoStore.failed}
          </div>
          {autoStore.lastMessage ? <div className="small" style={{ marginTop: 6 }}>{autoStore.lastMessage}</div> : null}
          {autoStore.error ? <pre className="small" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{autoStore.error}</pre> : null}
        </div>
      ) : null}


      <div className="card section-gap seo-control-panel seo-control-panel-primary">
        <div className="seo-panel-header">
          <div>
            <h2 className="card-title">3. SEO format для ParserVo товаров</h2>
            <p className="muted small">Этот блок работает только с товарами ParserVo по текущим фильтрам сверху. Используй, когда нужны переменные: цвет, SKU, цена, тип товара.</p>
          </div>
          <span className="badge badge-green">ParserVo linked products</span>
        </div>
        <Form method="post" className="parservo-template-seo-form seo-smart-form">
          <input type="hidden" name="autoIntent" value="auto_parservo_template_seo_tick" />
          <div className="form-grid seo-template-text-grid">
            <div>
              <label>SEO title format</label>
              <input name="parservoTemplateTitleTemplate" defaultValue={defaultParserVoSeoTitleTemplate()} />
              <p className="muted small">Переменные: <code>{'{brand}'}</code>, <code>{'{color}'}</code>, <code>{'{nameType}'}</code>, <code>{'{sku}'}</code>, <code>{'{price}'}</code>, <code>{'{title}'}</code></p>
            </div>
            <div>
              <label>Meta description format</label>
              <textarea name="parservoTemplateDescriptionTemplate" defaultValue={defaultParserVoSeoDescriptionTemplate()} />
            </div>
          </div>
          <div className="form-grid seo-template-grid">
            <div>
              <label>Партия</label>
              <select name="parservoTemplateLimit" defaultValue="10">
                <option value="10">10 товаров</option>
                <option value="20">20 товаров</option>
                <option value="50">50 товаров</option>
              </select>
            </div>
          </div>
          <div className="button-row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" name="intent" value="preview_parservo_template_seo" disabled={isBusy || autoStore.running}>Preview ParserVo SEO</button>
            <button className="btn btn-primary" type="button" onClick={() => startAutoStore(".parservo-template-seo-form", "ParserVo SEO template запущен по текущим фильтрам.")} disabled={isBusy || autoStore.running || autoStoreFetcher.state !== "idle"}>Start automatic ParserVo SEO</button>
            <button className="btn btn-danger" type="button" onClick={stopAutoStore} disabled={!autoStore.running}>Stop</button>
          </div>
        </Form>
      </div>

      <div className="card section-gap seo-control-panel">
        <h2 className="card-title">4. ParserVo Vendor / Brand normalization</h2>
        <p className="muted small">
          Используй этот блок для брендов. Он не просто заменяет текст, а принудительно ставит Shopify Vendor и может сразу пересоздать SEO.
          Пример: <strong>Ami Alexandre Mattiussi</strong> → <strong>Ami Paris</strong>. Если ParserVo brand уже был изменён раньше, выбери в фильтре Brand = Ami Paris и запусти только Shopify vendor + Regenerate SEO.
        </p>
        <Form method="post" className="brand-normalization-form">
          <div className="form-grid seo-replace-grid">
            <div>
              <label>Старый бренд / фильтр</label>
              <input name="fromBrand" defaultValue="Ami Alexandre Mattiussi" placeholder="Ami Alexandre Mattiussi" />
            </div>
            <div>
              <label>Новый бренд</label>
              <input name="targetBrand" defaultValue="Ami Paris" placeholder="Ami Paris" />
            </div>
            <div>
              <label>Партия</label>
              <select name="brandNormalizeLimit" defaultValue="10">
                <option value="10">10 товаров</option>
                <option value="20">20 товаров</option>
                <option value="50">50 товаров</option>
              </select>
            </div>
          </div>

          <div className="checkbox-grid seo-replace-checkboxes">
            <label><input type="checkbox" name="brandNormalizeFields" value="parservo_brand" defaultChecked /> ParserVo brand</label>
            <label><input type="checkbox" name="brandNormalizeFields" value="shopify_vendor" defaultChecked /> Shopify vendor</label>
            <label><input type="checkbox" name="brandNormalizeFields" value="regenerate_seo" defaultChecked /> Regenerate Shopify SEO</label>
          </div>

          <div className="button-row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" name="intent" value="preview_brand_normalize" disabled={isBusy || autoBrand.running}>Preview brand batch</button>
            <button className="btn btn-primary" type="button" onClick={startAutoBrand} disabled={isBusy || autoBrand.running || autoBrandFetcher.state !== "idle"}>Start automatic brand normalization</button>
            <button className="btn btn-danger" type="button" onClick={stopAutoBrand} disabled={!autoBrand.running}>Stop</button>
            <span className="muted small">Для точности сначала поставь Brand filter = Ami Alexandre Mattiussi. Если уже менял ParserVo brand, поставь Brand filter = Ami Paris.</span>
          </div>
        </Form>

        {(autoBrand.running || autoBrand.processed > 0 || autoBrand.lastMessage || autoBrand.error) ? (
          <div className={`notice ${autoBrand.error ? "notice-error" : autoBrand.running ? "notice-warning" : "notice-success"}`} style={{ marginTop: 12 }}>
            <strong>{autoBrand.running ? "Brand normalization is running" : "Brand normalization status"}</strong>
            <div className="small" style={{ marginTop: 6 }}>
              Processed: {autoBrand.processed} · Updated: {autoBrand.updated} · Skipped: {autoBrand.skipped} · Failed: {autoBrand.failed}
            </div>
            {autoBrand.lastMessage ? <div className="small" style={{ marginTop: 6 }}>{autoBrand.lastMessage}</div> : null}
            {autoBrand.error ? <pre className="small" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{autoBrand.error}</pre> : null}
          </div>
        ) : null}
      </div>

      <div className="card section-gap">
        <h2 className="card-title">Advanced: точечная замена текста</h2>
        <p className="muted small">
          Массовая замена текста в выбранных блоках. Например: <strong>Ami Alexandre Mattiussi</strong> → <strong>Ami Paris</strong>.
          Сначала сделай Preview, потом запускай автоматическую замену. Система будет сама обрабатывать товары маленькими партиями по 10/20/50, без ручного нажатия каждого batch.
        </p>
        <Form method="post" className="bulk-replace-form">
          <div className="form-grid seo-replace-grid">
            <div>
              <label>Найти текст</label>
              <input name="findText" defaultValue="Ami Alexandre Mattiussi" placeholder="Ami Alexandre Mattiussi" />
            </div>
            <div>
              <label>Заменить на</label>
              <input name="replaceWith" defaultValue="Ami Paris" placeholder="Ami Paris" />
            </div>
            <div>
              <label>Лимит за запуск</label>
              <select name="replaceLimit" defaultValue="10">
                <option value="10">10 товаров</option>
                <option value="20">20 товаров</option>
                <option value="50">50 товаров</option>
              </select>
            </div>
          </div>

          <div className="checkbox-grid seo-replace-checkboxes">
            <label><input type="checkbox" name="replaceFields" value="parservo_brand" defaultChecked /> ParserVo brand</label>
            <label><input type="checkbox" name="replaceFields" value="shopify_vendor" defaultChecked /> Shopify vendor</label>
            <label><input type="checkbox" name="replaceFields" value="shopify_seo_title" defaultChecked /> Shopify SEO title</label>
            <label><input type="checkbox" name="replaceFields" value="shopify_seo_description" defaultChecked /> Shopify meta description</label>
            <label><input type="checkbox" name="replaceFields" value="parservo_title" /> ParserVo title</label>
            <label><input type="checkbox" name="replaceFields" value="parservo_original_title" /> ParserVo original title</label>
            <label><input type="checkbox" name="replaceFields" value="shopify_title" /> Shopify product title</label>
          </div>

          <div className="button-row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" name="intent" value="preview_bulk_replace" disabled={isBusy || autoReplace.running}>Preview first batch</button>
            <button className="btn" type="submit" name="intent" value="apply_bulk_replace" disabled={isBusy || autoReplace.running}>Apply one batch</button>
            <button className="btn btn-primary" type="button" onClick={startAutoReplace} disabled={isBusy || autoReplace.running || autoReplaceFetcher.state !== "idle"}>Start automatic replace</button>
            <button className="btn btn-danger" type="button" onClick={stopAutoReplace} disabled={!autoReplace.running}>Stop automatic replace</button>
            <span className="muted small">Используются текущие фильтры SEO Center. Для AMI сначала выбери Brand = Ami Alexandre Mattiussi или Search = Ami.</span>
          </div>
        </Form>

        {(autoReplace.running || autoReplace.processed > 0 || autoReplace.lastMessage || autoReplace.error) ? (
          <div className={`notice ${autoReplace.error ? "notice-error" : autoReplace.running ? "notice-warning" : "notice-success"}`} style={{ marginTop: 12 }}>
            <strong>{autoReplace.running ? "Automatic replace is running" : "Automatic replace status"}</strong>
            <div className="small" style={{ marginTop: 6 }}>
              Processed: {autoReplace.processed} · Updated: {autoReplace.updated} · Skipped: {autoReplace.skipped} · Failed: {autoReplace.failed}
            </div>
            {autoReplace.lastMessage ? <div className="small" style={{ marginTop: 6 }}>{autoReplace.lastMessage}</div> : null}
            {autoReplace.error ? <pre className="small" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{autoReplace.error}</pre> : null}
          </div>
        ) : null}

        {actionData?.replacePreview?.length ? (
          <div className="bulk-preview-box">
            <strong>Preview товаров:</strong>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Brand before</th>
                  <th>Brand after</th>
                  <th>Будет изменено</th>
                </tr>
              </thead>
              <tbody>
                {actionData.replacePreview.map((row) => (
                  <tr key={row.id}>
                    <td>{row.title}</td>
                    <td>{row.sku || "—"}</td>
                    <td>{row.brandBefore || "—"}</td>
                    <td>{row.brandAfter || "—"}</td>
                    <td>{row.changedFields.length ? row.changedFields.join(", ") : "нет изменений"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <Form method="post" className="card section-gap">
        {hiddenPageProducts(visibleRows)}
        {Object.entries(selectedIds).filter(([, checked]) => checked).map(([id]) => (
          <input key={id} type="hidden" name="selectedProductIds" value={id} />
        ))}
        <div className="button-row">
          <button className="btn btn-primary" type="submit" name="intent" value="update_selected_generated" disabled={isBusy || selectedCount === 0}>Update selected generated SEO</button>
          <button className="btn" type="submit" name="intent" value="update_page_generated" disabled={isBusy || visibleRows.length === 0}>Update current page SEO</button>
          <button className="btn" type="submit" name="intent" value="update_next_filtered_generated" disabled={isBusy}>Update next 20 filtered</button>
          <input type="hidden" name="limit" value="20" />
          <span className="muted small">Generated SEO безопасно перезаписывает SEO title и meta description в Shopify.</span>
        </div>
      </Form>

      <div className="card section-gap seo-table-card">
        <div className="button-row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 className="card-title" style={{ margin: 0 }}>Products SEO</h2>
          <div className="button-row">
            <Link className="btn" to={pageUrl(1)}>First</Link>
            <Link className="btn" to={pageUrl(pagination.page - 1)}>Prev</Link>
            <span className="small">{pagination.from}–{pagination.to} / {pagination.filteredTotal}</span>
            <Link className="btn" to={pageUrl(pagination.page + 1)}>Next</Link>
            <Link className="btn" to={pageUrl(pagination.totalPages)}>Last</Link>
          </div>
        </div>

        <div className="table-wrap seo-table-wrap">
          <table className="seo-table">
            <thead>
              <tr>
                <th>Select</th>
                <th>Image</th>
                <th>Product</th>
                <th>Generated SEO</th>
                <th>Current Shopify SEO</th>
                <th>Status</th>
                <th>Manual edit</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row: any) => {
                const product = row.product;
                const selected = Boolean(selectedIds[product.id]);
                return (
                  <tr key={product.id}>
                    <td>
                      <input type="checkbox" checked={selected} onChange={(event) => setRowsSelected([product.id], event.currentTarget.checked)} />
                    </td>
                    <td>{product.imageUrl ? <img className="product-image" src={product.imageUrl} alt={product.originalTitle || product.title} /> : "—"}</td>
                    <td className="seo-product-cell">
                      <strong>{product.originalTitle || product.title}</strong><br />
                      <span className="muted small">{product.brand || "—"} · {product.supplierSymbol || product.modelCode || product.supplierProductId || "No SKU"}</span><br />
                      {row.shopifyAdminUrl ? <a href={row.shopifyAdminUrl} target="_blank" rel="noreferrer">Open in Shopify</a> : null}
                    </td>
                    <td className="seo-text-cell">
                      <strong>Title</strong> <span className={row.generated.title.length > SEO_TITLE_MAX ? "badge badge-red" : "badge badge-green"}>{row.generated.title.length}/{SEO_TITLE_MAX}</span>
                      <div className="seo-preview-text">{row.generated.title}</div>
                      <strong>Description</strong> <span className={row.generated.description.length > SEO_DESCRIPTION_MAX ? "badge badge-red" : "badge badge-green"}>{row.generated.description.length}/{SEO_DESCRIPTION_MAX}</span>
                      <div className="seo-preview-text muted">{row.generated.description}</div>
                    </td>
                    <td className="seo-text-cell">
                      <strong>Title</strong> <span className="small muted">{row.current.title.length}/{SEO_TITLE_MAX}</span>
                      <div className="seo-preview-text">{row.current.title || "—"}</div>
                      <strong>Description</strong> <span className="small muted">{row.current.description.length}/{SEO_DESCRIPTION_MAX}</span>
                      <div className="seo-preview-text muted">{row.current.description || "—"}</div>
                    </td>
                    <td><span className={row.status.className}>{row.status.label}</span></td>
                    <td>
                      <Form method="post" className="seo-manual-form">
                        <input type="hidden" name="intent" value="update_single_manual" />
                        <input type="hidden" name="productId" value={product.id} />
                        <label>SEO title</label>
                        <input name="seoTitle" defaultValue={row.current.title || row.generated.title} maxLength={SEO_TITLE_MAX} />
                        <label>Meta description</label>
                        <textarea name="seoDescription" defaultValue={row.current.description || row.generated.description} maxLength={SEO_DESCRIPTION_MAX} />
                        <button className="btn btn-primary" type="submit" disabled={isBusy}>Save manual SEO</button>
                      </Form>
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 ? (
                <tr><td colSpan={7} className="muted">Нет товаров по выбранным фильтрам.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
