import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation, useLocation, useNavigate } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { statusBadgeClass } from "../services/status";
import {
  cleanupImportedProductsDeletedInShopify,
  createImportedProductsInShopify,
  createShopifyProductFromImported,
  deleteImportedProductsAndShopify,
  deleteShopifyProductAndImported,
  syncShopifyInventoryForProduct,
  syncCategoryMetafieldsForImportedProduct,
  syncCategoryMetafieldsForImportedProducts,
} from "../services/shopify-products.server";

const ALPHA_SIZE_ORDER = ["XXXXS", "XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];
const PRODUCT_PAGE_SIZE_OPTIONS = [50, 100, 200];
const PRODUCT_FILTER_QUERY_KEYS = [
  "page",
  "pageSize",
  "q",
  "shopify",
  "status",
  "stock",
  "sync",
  "type",
  "filterName",
  "color",
  "gender",
  "sizeMode",
  "audit",
];

const DEFAULT_NO_SIZE_LABELS = ["DEFAULT TITLE", "UNI", "ONE SIZE", "ONESIZE", "OS"];
const DEFAULT_NO_SIZE_DB_LABELS = ["Default Title", "DEFAULT TITLE", "default title", "UNI", "Uni", "uni", "ONE SIZE", "One Size", "one size", "ONESIZE", "OneSize", "OS", "Os", "os"];
const TYPE_FILTER_OPTIONS = [
  "Боді", "Ботильйони", "Брюки", "Водолазки", "Джинси", "Зіп-Худі", "Капелюхи", "Кардигани",
  "Кепки", "Кросівки", "Куртки", "Лофери", "Мокасини", "Мюлі", "Пальта", "Поло", "Пуховики",
  "Ремені", "Рюкзаки", "Сабо", "Сандалі", "Светри", "Світшоти", "Сорочки", "Сумки",
  "Сумки на плече", "Топи", "Туфлі", "Футболки", "Худі", "Черевики", "Шапки", "Шарфи",
  "Шкарпетки", "Шльопанці", "Шопери", "Шорти", "Шорти для плавання",
];
const FILTER_NAME_OPTIONS = [
  "Босоніжки", "Ботильйони", "Брюки та джинси", "Верхній одяг", "Головні убори", "Кросівки",
  "Лофери", "Мокасини", "Мюлі", "Плавки", "Поло", "Ремені", "Рюкзаки", "Сабо", "Сандалі",
  "Светри та кардигани", "Сорочки", "Сумки", "Топи", "Туфлі", "Футболки та поло",
  "Худі та світшоти", "Черевики", "Шарфи", "Шкарпетки", "Шльопанці", "Шопери", "Шорти",
];
const COLOR_FILTER_OPTIONS = [
  "Beige", "Black", "Blue", "Bronze", "Brown", "Gold", "Gray", "Green", "Grey", "Navy", "Orange",
  "Pink", "Purple", "Red", "Rose gold", "Silver", "White", "Yellow",
];
const GENDER_FILTER_OPTIONS = ["Female", "Male"];
const STOCK_STATUS_OPTIONS = ["supplier_available", "supplier_sold_out"];


function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number, max = 500) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.round(parsed)));
}

function parseProductsPage(value: string | null) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.max(1, Math.round(parsed));
}

function parseProductsPageSize(value: string | null) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  return PRODUCT_PAGE_SIZE_OPTIONS.includes(parsed) ? parsed : 50;
}

function parseQueueStartedAt(value: FormDataEntryValue | null) {
  const parsed = new Date(String(value || ""));
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function getSelectedIds(formData: FormData) {
  return Array.from(new Set(formData.getAll("selectedProductIds").map((value) => String(value)).filter(Boolean)));
}

function sizeSortKey(value: string) {
  const normalized = normalizeString(value).replace(",", ".").toUpperCase();
  const numeric = Number(normalized.replace(/[^0-9.]/g, ""));

  if (/^\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(numeric)) {
    return { group: 1, rank: numeric, label: normalized };
  }

  const alphaRank = ALPHA_SIZE_ORDER.indexOf(normalized);
  if (alphaRank >= 0) return { group: 2, rank: alphaRank, label: normalized };

  return { group: 3, rank: 9999, label: normalized };
}

function compareSizes(a: string, b: string) {
  const left = sizeSortKey(a);
  const right = sizeSortKey(b);

  if (left.group !== right.group) return left.group - right.group;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.label.localeCompare(right.label, "uk");
}

function sortVariants(variants: any[]) {
  return [...(variants || [])].sort((a, b) => compareSizes(a.size || a.supplierSizeLabel || "", b.size || b.supplierSizeLabel || ""));
}

function isDefaultNoSizeVariant(variant: any) {
  const size = normalizeString(variant?.size).toUpperCase();
  const supplierSize = normalizeString(variant?.supplierSizeLabel).toUpperCase();
  return DEFAULT_NO_SIZE_LABELS.includes(size)
    || DEFAULT_NO_SIZE_LABELS.includes(supplierSize);
}

function displayAvailableSizes(variants: any[]) {
  const labels = sortVariants(variants)
    .filter((variant: any) => variant.available)
    .filter((variant: any) => !isDefaultNoSizeVariant(variant))
    .map((variant: any) => normalizeString(variant.size) || normalizeString(variant.supplierSizeLabel))
    .filter(Boolean);

  return labels.join(", ");
}

function hasAvailableStock(variants: any[]) {
  return (variants || []).some((variant: any) => variant.available);
}

function displayTitle(product: any) {
  return product.originalTitle || product.title || "Untitled product";
}

function transferMessage(result: { total: number; created: number; skipped: number; failed: number }) {
  return `Shopify transfer finished. Total: ${result.total}. Created: ${result.created}. Skipped: ${result.skipped}. Failed: ${result.failed}.`;
}

type ProductFilters = {
  q: string;
  shopify: string;
  status: string;
  stock: string;
  sync: string;
  type: string;
  filterName: string;
  color: string;
  gender: string;
  sizeMode: string;
  audit: string;
};

function readProductFilters(url: URL): ProductFilters {
  return {
    q: normalizeString(url.searchParams.get("q")),
    shopify: normalizeString(url.searchParams.get("shopify")) || "all",
    status: normalizeString(url.searchParams.get("status")) || "all",
    stock: normalizeString(url.searchParams.get("stock")) || "all",
    sync: normalizeString(url.searchParams.get("sync")) || "all",
    type: normalizeString(url.searchParams.get("type")) || "all",
    filterName: normalizeString(url.searchParams.get("filterName")) || "all",
    color: normalizeString(url.searchParams.get("color")) || "all",
    gender: normalizeString(url.searchParams.get("gender")) || "all",
    sizeMode: normalizeString(url.searchParams.get("sizeMode")) || "all",
    audit: normalizeString(url.searchParams.get("audit")) || "all",
  };
}

function containsInsensitive(value: string) {
  return { contains: value, mode: "insensitive" as const };
}

function buildKindSearchTerms(kind: string) {
  const map: Record<string, string[]> = {
    "Ботильйони": ["ankle boot", "ботильйон"],
    "Кросівки": ["sneaker", "trainer", "sports shoes", "кросівк"],
    "Лофери": ["loafer", "лофер"],
    "Мокасини": ["moccasin", "мокасин"],
    "Мюлі": ["mule", "мюлі"],
    "Сабо": ["clog", "сабо"],
    "Сандалі": ["sandal", "сандал", "босоніж"],
    "Шльопанці": ["slide", "slipper", "flip flop", "шльопан"],
    "Черевики": ["boot", "черевик"],
    "Туфлі": ["pump", "heel", "heeled shoes", "shoe", "туфл"],
    "Рюкзаки": ["backpack", "рюкзак"],
    "Шопери": ["shopper", "tote", "шопер"],
    "Сумки на плече": ["shoulder bag", "сумка на плече"],
    "Сумки": ["bag", "handbag", "сумк"],
    "Ремені": ["belt", "ремен"],
    "Шарфи": ["scarf", "shawl", "шарф"],
    "Шкарпетки": ["sock", "шкарпет"],
    "Кепки": ["cap", "кепк"],
    "Шапки": ["hat", "beanie", "шапк", "капелюх"],
    "Шорти для плавання": ["swim shorts", "swimming shorts", "плавк"],
    "Шорти": ["shorts", "шорти"],
    "Джинси": ["jeans", "джинс"],
    "Брюки": ["trousers", "pants", "брюк", "штани"],
    "Пуховики": ["down jacket", "puffer", "пухов"],
    "Куртки": ["jacket", "bomber", "куртк"],
    "Пальта": ["coat", "пальт"],
    "Кардигани": ["cardigan", "кардиган"],
    "Водолазки": ["turtleneck", "roll neck", "водолаз"],
    "Зіп-Худі": ["zip hoodie", "zip-hoodie", "зіп-худі", "зип-худі"],
    "Худі": ["hoodie", "худі"],
    "Світшоти": ["sweatshirt", "світшот"],
    "Светри": ["sweater", "pullover", "knitwear", "светр"],
    "Поло": ["polo", "поло"],
    "Футболки": ["t-shirt", "tshirt", "tee", "футболк"],
    "Сорочки": ["shirt", "сорочк"],
    "Боді": ["bodysuit", "боді"],
    "Топи": ["top", "топ"],
    "Брюки та джинси": ["trousers", "pants", "jeans", "брюк", "джинс", "штани"],
    "Верхній одяг": ["jacket", "coat", "puffer", "куртк", "пальт", "пухов"],
    "Головні убори": ["cap", "hat", "beanie", "кепк", "шапк", "капелюх"],
    "Плавки": ["swim shorts", "swimming shorts", "плавк"],
    "Светри та кардигани": ["sweater", "cardigan", "pullover", "knitwear", "светр", "кардиган"],
    "Футболки та поло": ["t-shirt", "tshirt", "tee", "polo", "футболк", "поло"],
    "Худі та світшоти": ["hoodie", "sweatshirt", "худі", "світшот"],
  };
  return map[kind] || [kind];
}

function searchOrForTerms(terms: string[]) {
  const fields = ["originalTitle", "title", "category", "categoryUa", "productType", "breadcrumbs"];
  return terms.flatMap((term) => fields.map((field) => ({ [field]: containsInsensitive(term) })));
}

function buildProductsWhere(shop: string, filters: ProductFilters) {
  const and: any[] = [{ shop }];
  const qTokens = filters.q.split(/\s+/).map((token) => token.trim()).filter(Boolean);

  for (const token of qTokens) {
    and.push({
      OR: [
        { originalTitle: containsInsensitive(token) },
        { title: containsInsensitive(token) },
        { brand: containsInsensitive(token) },
        { supplierSymbol: containsInsensitive(token) },
        { modelCode: containsInsensitive(token) },
        { supplierUrl: containsInsensitive(token) },
        { color: containsInsensitive(token) },
        { colorUa: containsInsensitive(token) },
        { gender: containsInsensitive(token) },
        { genderUa: containsInsensitive(token) },
        { category: containsInsensitive(token) },
        { categoryUa: containsInsensitive(token) },
        { productType: containsInsensitive(token) },
        { breadcrumbs: containsInsensitive(token) },
        { status: containsInsensitive(token) },
        { stockSourceStatus: containsInsensitive(token) },
      ],
    });
  }

  if (filters.shopify === "created") and.push({ shopifyProductGid: { not: null } });
  if (filters.shopify === "not_created") and.push({ shopifyProductGid: null });
  if (filters.status !== "all") and.push({ status: filters.status });
  if (filters.stock !== "all") and.push({ stockSourceStatus: filters.stock });
  if (filters.sync === "enabled") and.push({ syncEnabled: true });
  if (filters.sync === "disabled") and.push({ syncEnabled: false });
  if (filters.color !== "all") {
    and.push({ OR: [{ color: containsInsensitive(filters.color) }, { colorUa: containsInsensitive(filters.color) }] });
  }
  if (filters.gender !== "all") {
    const terms = filters.gender === "Female" ? ["female", "women", "жіноч", "жен"] : ["male", "men", "чолов", "муж"];
    and.push({ OR: terms.flatMap((term) => [
      { gender: containsInsensitive(term) },
      { genderUa: containsInsensitive(term) },
      { breadcrumbs: containsInsensitive(term) },
    ]) });
  }
  if (filters.type !== "all") and.push({ OR: searchOrForTerms(buildKindSearchTerms(filters.type)) });
  if (filters.filterName !== "all") and.push({ OR: searchOrForTerms(buildKindSearchTerms(filters.filterName)) });

  if (filters.sizeMode === "with_size") {
    and.push({ variants: { some: { available: true, size: { notIn: DEFAULT_NO_SIZE_LABELS } } } });
  }
  if (filters.sizeMode === "no_size") {
    and.push({ variants: { some: { available: true, OR: [
      { size: { in: DEFAULT_NO_SIZE_DB_LABELS } },
      { supplierSizeLabel: { in: DEFAULT_NO_SIZE_DB_LABELS } },
    ] } } });
  }
  if (filters.sizeMode === "sold_out") {
    and.push({ OR: [{ stockSourceStatus: "supplier_sold_out" }, { variants: { none: { available: true } } }] });
  }

  if (filters.audit === "missing_color") and.push({ AND: [{ OR: [{ color: null }, { color: "" }] }, { OR: [{ colorUa: null }, { colorUa: "" }] }] });
  if (filters.audit === "missing_price") and.push({ OR: [{ salePriceUah: null }, { salePriceUah: { lte: 0 } }] });
  if (filters.audit === "missing_image") and.push({ OR: [{ imageUrl: null }, { imageUrl: "" }] });
  if (filters.audit === "supplier_sold_out") and.push({ stockSourceStatus: "supplier_sold_out" });

  return { AND: and };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = parseProductsPage(url.searchParams.get("page"));
  const pageSize = parseProductsPageSize(url.searchParams.get("pageSize"));
  const filters = readProductFilters(url);
  const cleanup = await cleanupImportedProductsDeletedInShopify(admin, session.shop);
  const where = buildProductsWhere(session.shop, filters);

  const [products, stats, filteredTotal, settings, distinctStatuses, distinctStocks] = await Promise.all([
    db.importedProduct.findMany({
      where,
      include: { variants: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    Promise.all([
      db.importedProduct.count({ where: { shop: session.shop } }),
      db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: null } }),
      db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null } } }),
      db.importedProduct.count({ where: { shop: session.shop, stockSourceStatus: "supplier_sold_out" } }),
    ]),
    db.importedProduct.count({ where }),
    db.appSettings.findUnique({ where: { shop: session.shop } }),
    db.importedProduct.findMany({
      where: { shop: session.shop },
      distinct: ["status"],
      select: { status: true },
      orderBy: { status: "asc" },
    }),
    db.importedProduct.findMany({
      where: { shop: session.shop },
      distinct: ["stockSourceStatus"],
      select: { stockSourceStatus: true },
      orderBy: { stockSourceStatus: "asc" },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));

  return {
    products,
    settings,
    cleanup,
    filters,
    filterOptions: {
      statuses: uniqueSorted(distinctStatuses.map((item) => item.status)),
      stocks: uniqueSorted([...STOCK_STATUS_OPTIONS, ...distinctStocks.map((item) => item.stockSourceStatus)]),
      types: TYPE_FILTER_OPTIONS,
      filterNames: FILTER_NAME_OPTIONS,
      colors: COLOR_FILTER_OPTIONS,
      genders: GENDER_FILTER_OPTIONS,
    },
    pagination: {
      page: safePage,
      pageSize,
      totalProducts: filteredTotal,
      unfilteredTotal: stats[0],
      totalPages,
      loaded: products.length,
      from: filteredTotal === 0 ? 0 : (safePage - 1) * pageSize + 1,
      to: Math.min(safePage * pageSize, filteredTotal),
    },
    stats: {
      total: stats[0],
      notCreated: stats[1],
      created: stats[2],
      soldOut: stats[3],
    },
  };
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const rowAction = String(formData.get("rowAction") || "");
  const selectedIds = getSelectedIds(formData);
  const batchLimit = parsePositiveInt(formData.get("batchLimit"), 20, 500);
  const settings = await db.appSettings.findUnique({ where: { shop: session.shop } });

  if (intent === "sync_all_stock_batch") {
    const stockBatchLimit = parsePositiveInt(formData.get("stockBatchLimit"), 8, 20);
    const queueStartedAt = parseQueueStartedAt(formData.get("startedAt"));
    const where: any = {
      shop: session.shop,
      shopifyProductGid: { not: null },
      syncEnabled: true,
      OR: [
        { lastSyncedAt: null },
        { lastSyncedAt: { lt: queueStartedAt } },
      ],
    };

    const remainingBefore = await db.importedProduct.count({ where });
    const productsToSync = await db.importedProduct.findMany({
      where,
      orderBy: [
        { lastSyncedAt: "asc" },
        { createdAt: "asc" },
      ],
      take: stockBatchLimit,
    });

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    let syncedVariants = 0;
    const errors: string[] = [];

    for (const product of productsToSync) {
      try {
        const result = await syncShopifyInventoryForProduct(admin, product.id, session.shop, {
          locationId: settings?.defaultShopifyLocationId || null,
          autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
          autoActivateAvailable: settings?.autoActivateAvailable ?? true,
        });

        if (result.skipped) {
          skipped += 1;

          await db.importedProduct.update({
            where: { id: product.id },
            data: { lastSyncedAt: new Date() },
          });

          await db.syncLog.create({
            data: {
              shop: session.shop,
              importedProductId: product.id,
              supplierName: product.supplierName,
              supplierUrl: product.supplierUrl,
              status: "gradual_shopify_inventory_sync_skipped",
              message: `Skipped during gradual stock sync: ${result.reason || "unknown reason"}`,
            },
          });
        } else {
          synced += 1;
          syncedVariants += Number(result.syncedVariants || 0);
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${product.originalTitle || product.title}: ${message}`);

        await db.importedProduct.update({
          where: { id: product.id },
          data: { lastSyncedAt: new Date() },
        });

        await db.syncLog.create({
          data: {
            shop: session.shop,
            importedProductId: product.id,
            supplierName: product.supplierName,
            supplierUrl: product.supplierUrl,
            status: "gradual_shopify_inventory_sync_error",
            message: `Failed during gradual Shopify inventory sync: ${message.slice(0, 450)}`,
            errorMessage: message,
          },
        });
      }
    }

    const remaining = await db.importedProduct.count({ where });

    return {
      ok: failed === 0,
      message: `Gradual stock sync batch finished. Processed: ${productsToSync.length}. Synced: ${synced}. Skipped: ${skipped}. Failed: ${failed}. Remaining: ${remaining}.`,
      errors: errors.slice(0, 20),
      batch: {
        startedAt: queueStartedAt.toISOString(),
        limit: stockBatchLimit,
        remainingBefore,
        processed: productsToSync.length,
        synced,
        skipped,
        failed,
        syncedVariants,
        remaining,
        done: remaining === 0 || productsToSync.length === 0,
      },
    };
  }

  if (intent === "create_selected_draft" || intent === "create_selected_active") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери товары галочками перед переносом." };
    const status = intent === "create_selected_active" ? "ACTIVE" : "DRAFT";
    const result = await createImportedProductsInShopify(admin, session.shop, {
      productIds: selectedIds,
      status,
      locationId: settings?.defaultShopifyLocationId || null,
    });

    return { ok: result.failed === 0, message: transferMessage(result), errors: result.errors.slice(0, 20) };
  }

  if (intent === "create_batch_draft" || intent === "create_batch_active") {
    const status = intent === "create_batch_active" ? "ACTIVE" : "DRAFT";
    const result = await createImportedProductsInShopify(admin, session.shop, {
      limit: batchLimit,
      status,
      locationId: settings?.defaultShopifyLocationId || null,
    });

    return { ok: result.failed === 0, message: transferMessage(result), errors: result.errors.slice(0, 20) };
  }

  if (intent === "create_all_draft" || intent === "create_all_active") {
    const status = intent === "create_all_active" ? "ACTIVE" : "DRAFT";
    const result = await createImportedProductsInShopify(admin, session.shop, {
      allNotCreated: true,
      status,
      locationId: settings?.defaultShopifyLocationId || null,
    });

    return { ok: result.failed === 0, message: transferMessage(result), errors: result.errors.slice(0, 20) };
  }

  if (intent === "delete_selected") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери товары галочками перед удалением." };
    const result = await deleteImportedProductsAndShopify(admin, session.shop, selectedIds);

    return {
      ok: result.failed === 0,
      message: `Deleted selected. Total: ${result.total}. From Shopify: ${result.deletedFromShopify}. From app: ${result.deletedFromApp}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "sync_selected_category_meta") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери уже созданные товары галочками." };
    const result = await syncCategoryMetafieldsForImportedProducts(admin, session.shop, selectedIds);
    return {
      ok: result.failed === 0,
      message: `Category metafields synced. Total: ${result.total}. Synced products: ${result.synced}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "enable_selected_sync" || intent === "disable_selected_sync") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери товары галочками." };
    const enabled = intent === "enable_selected_sync";
    const result = await db.importedProduct.updateMany({
      where: { shop: session.shop, id: { in: selectedIds } },
      data: { syncEnabled: enabled },
    });
    return { ok: true, message: `${enabled ? "Enabled" : "Disabled"} sync for ${result.count} products.` };
  }

  if (rowAction) {
    const [action, productId] = rowAction.split(":");
    if (!productId) return { ok: false, error: "Product ID is missing." };

    const product = await db.importedProduct.findFirst({ where: { id: productId, shop: session.shop } });
    if (!product) return { ok: false, error: "Product not found." };

    if (action === "disable_sync" || action === "enable_sync") {
      const enabled = action === "enable_sync";
      await db.importedProduct.update({
        where: { id: product.id },
        data: { syncEnabled: enabled, status: enabled ? (product.shopifyProductGid ? "active" : "imported") : "manual_disabled" },
      });
      return { ok: true, message: `${enabled ? "Enabled" : "Disabled"} sync for ${displayTitle(product)}.` };
    }

    if (action === "delete_product") {
      const result = await deleteShopifyProductAndImported(admin, product.id, session.shop);
      return {
        ok: true,
        message: result.deletedFromShopify
          ? `Deleted from Shopify and app: ${result.title}`
          : `Deleted from app: ${result.title}`,
      };
    }

    if (action === "create_shopify_draft" || action === "create_shopify_active") {
      const status = action === "create_shopify_active" ? "ACTIVE" : "DRAFT";
      const result = await createShopifyProductFromImported(admin, product.id, session.shop, {
        status,
        locationId: settings?.defaultShopifyLocationId || null,
      });

      return {
        ok: true,
        message: result.skipped
          ? "Товар уже был создан в Shopify."
          : `Товар создан в Shopify как ${status === "ACTIVE" ? "Active" : "Draft"}: ${result.productTitle}`,
      };
    }

    if (action === "sync_category_meta") {
      const result = await syncCategoryMetafieldsForImportedProduct(admin, product.id, session.shop);
      return {
        ok: result.synced > 0,
        message: `Category metafields sync. Attempted: ${result.attempted}. Synced: ${result.synced}. Skipped: ${result.skipped}.`,
        errors: result.errors.slice(0, 20),
      };
    }

    if (action === "sync_now") {
      const result = await syncShopifyInventoryForProduct(admin, product.id, session.shop, {
        locationId: settings?.defaultShopifyLocationId || null,
        autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
        autoActivateAvailable: settings?.autoActivateAvailable ?? true,
      });

      return {
        ok: !result.skipped,
        message: result.skipped
          ? `Inventory sync skipped: ${result.reason}`
          : `Inventory synced. Variants: ${result.syncedVariants}. Available sizes: ${result.availableSizes.join(", ") || "none"}`,
      };
    }
  }

  return { ok: true };
};

type ActionData = {
  ok?: boolean;
  message?: string;
  error?: string;
  errors?: string[];
  batch?: {
    startedAt: string;
    limit: number;
    remainingBefore: number;
    processed: number;
    synced: number;
    skipped: number;
    failed: number;
    syncedVariants: number;
    remaining: number;
    done: boolean;
  };
};

type GradualStockSyncState = {
  running: boolean;
  startedAt: string;
  processed: number;
  synced: number;
  skipped: number;
  failed: number;
  remaining: number | null;
  message: string;
  errors: string[];
};

const initialGradualStockSyncState: GradualStockSyncState = {
  running: false,
  startedAt: "",
  processed: 0,
  synced: 0,
  skipped: 0,
  failed: 0,
  remaining: null,
  message: "",
  errors: [],
};

function productSearchText(product: any) {
  return ` ${[
    product.originalTitle,
    product.title,
    product.category,
    product.categoryUa,
    product.productType,
    product.breadcrumbs,
    product.supplierUrl,
  ].filter(Boolean).join(" ")} `.toLowerCase();
}

function detectDisplayKind(product: any) {
  const titleText = ` ${[product.originalTitle, product.title].filter(Boolean).join(" ")} `.toLowerCase();
  const fullText = productSearchText(product);

  const detect = (source: string) => {
    if (/ankle boots?|ботильйон/.test(source)) return "ankle_boots";
    if (/sneakers?|trainers?|sports shoes?|кросівк/.test(source)) return "sneakers";
    if (/loafers?|лофер/.test(source)) return "loafers";
    if (/moccasins?|мокасин/.test(source)) return "moccasins";
    if (/mules?|мюлі/.test(source)) return "mules";
    if (/clogs?|сабо/.test(source)) return "clogs";
    if (/sandals?|сандал|босоніж/.test(source)) return "sandals";
    if (/flip flops?|slides?|slippers?|шльопанц/.test(source)) return "slides";
    if (/boots?|черевик/.test(source)) return "boots";
    if (/pumps?|heeled shoes?|heels?|туфл/.test(source)) return "shoes";
    if (/backpacks?|рюкзак/.test(source)) return "backpack";
    if (/shoppers?|tote bags?|шопер/.test(source)) return "shopper";
    if (/shoulder bags?|сумк[аи] на плече/.test(source)) return "shoulder_bag";
    if (/handbags?|bags?|сумк/.test(source)) return "bag";
    if (/belts?|ремен/.test(source)) return "belt";
    if (/scarves?|shawls?|шарф/.test(source)) return "scarf";
    if (/socks?|шкарпет/.test(source)) return "socks";
    if (/caps?|кепк/.test(source)) return "cap";
    if (/hats?|beanies?|шапк|капелюх/.test(source)) return "hat";
    if (/\bswim shorts?\b|\bswimming shorts?\b|плавк|шорти для плавання/.test(source)) return "swim_shorts";
    if (/\bshorts\b|шорти/.test(source)) return "shorts";
    if (/jeans|джинс/.test(source)) return "jeans";
    if (/trousers?|pants|брюк|штани/.test(source)) return "trousers";
    if (/down jacket|puffer|пухов/.test(source)) return "down_jacket";
    if (/bomber jackets?|jackets?|куртк/.test(source)) return "jacket";
    if (/coats?|пальт/.test(source)) return "coat";
    if (/cardigans?|кардиган/.test(source)) return "cardigan";
    if (/turtlenecks?|roll neck|high neck|водолаз/.test(source)) return "turtleneck";
    if (/zip[-\s]?hoodie|зіп[-\s]?худі|зип[-\s]?худі/.test(source)) return "zip_hoodie";
    if (/hoodies?|худі/.test(source)) return "hoodie";
    if (/\bsweatshirts?\b|світшот/.test(source)) return "sweatshirt";
    if (/\bsweaters?\b|\bpullovers?\b|\bknitwear\b|светр/.test(source)) return "sweater";
    if (/\bpolos?\b|поло/.test(source)) return "polo";
    if (/\bt[-\s]?shirts?\b|\btees?\b|футболк/.test(source)) return "tshirt";
    if (/\blong[-\s]?sleeves?\b|лонгслів/.test(source)) return "longsleeve";
    if (/\bshirts?\b|сорочк/.test(source)) return "shirt";
    if (/bodysuits?|боді/.test(source)) return "bodysuit";
    if (/tops?|топ/.test(source)) return "top";
    return "";
  };

  return detect(titleText) || detect(fullText);
}

function displayProductType(product: any) {
  const map: Record<string, string> = {
    ankle_boots: "Ботильйони", sneakers: "Кросівки", loafers: "Лофери", moccasins: "Мокасини",
    mules: "Мюлі", clogs: "Сабо", sandals: "Сандалі", slides: "Шльопанці", boots: "Черевики", shoes: "Туфлі",
    backpack: "Рюкзаки", shopper: "Шопери", shoulder_bag: "Сумки на плече", bag: "Сумки", belt: "Ремені",
    scarf: "Шарфи", socks: "Шкарпетки", cap: "Кепки", hat: "Шапки", swim_shorts: "Шорти для плавання",
    shorts: "Шорти", jeans: "Джинси", trousers: "Брюки", down_jacket: "Пуховики", jacket: "Куртки", coat: "Пальта",
    cardigan: "Кардигани", turtleneck: "Водолазки", zip_hoodie: "Зіп-Худі", hoodie: "Худі", sweatshirt: "Світшоти",
    sweater: "Светри", longsleeve: "Футболки", polo: "Поло", tshirt: "Футболки", shirt: "Сорочки", bodysuit: "Боді", top: "Топи",
  };
  return map[detectDisplayKind(product)] || product.categoryUa || product.productType || "—";
}

function displayFilterName(product: any) {
  const map: Record<string, string> = {
    ankle_boots: "Ботильйони", sneakers: "Кросівки", loafers: "Лофери", moccasins: "Мокасини", mules: "Мюлі",
    clogs: "Сабо", sandals: "Сандалі", slides: "Шльопанці", boots: "Черевики", shoes: "Туфлі", backpack: "Рюкзаки",
    shopper: "Шопери", shoulder_bag: "Сумки", bag: "Сумки", belt: "Ремені", scarf: "Шарфи", socks: "Шкарпетки",
    cap: "Головні убори", hat: "Головні убори", swim_shorts: "Плавки", shorts: "Шорти", jeans: "Брюки та джинси",
    trousers: "Брюки та джинси", down_jacket: "Верхній одяг", jacket: "Верхній одяг", coat: "Верхній одяг",
    cardigan: "Светри та кардигани", turtleneck: "Светри та кардигани", zip_hoodie: "Худі та світшоти",
    hoodie: "Худі та світшоти", sweatshirt: "Худі та світшоти", sweater: "Светри та кардигани",
    longsleeve: "Футболки та поло", polo: "Футболки та поло", tshirt: "Футболки та поло", shirt: "Сорочки",
    bodysuit: "Топи", top: "Топи",
  };
  return map[detectDisplayKind(product)] || "—";
}

function displayNameType(product: any) {
  const map: Record<string, string> = {
    ankle_boots: "Ботильйони", sneakers: "Кросівки", loafers: "Лофери", moccasins: "Мокасини", mules: "Мюлі",
    clogs: "Сабо", sandals: "Сандалі", slides: "Шльопанці", boots: "Черевики", shoes: "Туфлі", backpack: "Рюкзак",
    shopper: "Шопер", shoulder_bag: "Сумка на плече", bag: "Сумка", belt: "Ремінь", scarf: "Шарф", socks: "Шкарпетки",
    cap: "Кепка", hat: "Шапка", swim_shorts: "Шорти для плавання", shorts: "Шорти", jeans: "Джинси", trousers: "Брюки",
    down_jacket: "Пуховик", jacket: "Куртка", coat: "Пальто", cardigan: "Кардиган", turtleneck: "Водолазка",
    zip_hoodie: "Зіп-Худі", hoodie: "Худі", sweatshirt: "Світшот", sweater: "Светр", longsleeve: "Лонгслів",
    polo: "Поло", tshirt: "Футболка", shirt: "Сорочка", bodysuit: "Боді", top: "Топ",
  };
  return map[detectDisplayKind(product)] || "—";
}

function displayColor(product: any) {
  const normalized = String(product.color || product.colorUa || "").toUpperCase().replace(/[\s_/-]+/g, " ").trim();
  const map: Record<string, string> = {
    BEIGE: "Beige", CREAM: "Beige", IVORY: "Beige", ECRU: "Beige", BLACK: "Black", BLUE: "Blue",
    BRONZE: "Bronze", BROWN: "Brown", GOLD: "Gold", GRAY: "Gray", GREY: "Grey", GREEN: "Green",
    NAVY: "Navy", "NAVY BLUE": "Navy", ORANGE: "Orange", PINK: "Pink", PURPLE: "Purple", RED: "Red",
    "ROSE GOLD": "Rose gold", SILVER: "Silver", WHITE: "White", YELLOW: "Yellow", БЕЖЕВИЙ: "Beige",
    ЧОРНИЙ: "Black", БЛАКИТНИЙ: "Blue", СИНІЙ: "Blue", КОРИЧНЕВИЙ: "Brown", СІРИЙ: "Gray", РОЖЕВИЙ: "Pink",
    ЗЕЛЕНИЙ: "Green", ЖОВТИЙ: "Yellow", БІЛИЙ: "White",
  };
  return map[normalized] || map[normalized.split(" ")[0]] || "—";
}

function displayTargetGender(product: any) {
  const source = `${product.gender || ""} ${product.genderUa || ""} ${product.breadcrumbs || ""}`;
  if (/female|women|жін|жен/i.test(source)) return "Female";
  if (/male|men|чолов|муж/i.test(source)) return "Male";
  return "—";
}

function formatMoney(value: unknown, digits = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "—";
  return numeric.toLocaleString("uk-UA", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}


function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean).filter((value) => value !== "—")))
    .sort((a, b) => a.localeCompare(b, "uk"));
}

function normalizeFilterValue(value: unknown) {
  return normalizeString(value) || "—";
}
function stockStatusLabel(value: string) {
  const map: Record<string, string> = {
    supplier_available: "В наличии у поставщика",
    supplier_sold_out: "Продан / нет у поставщика",
  };
  return map[value] || value;
}

function statusLabel(value: string) {
  const map: Record<string, string> = {
    imported: "Imported",
    active: "Active",
    shopify_draft: "Shopify draft",
    manual_disabled: "Sync disabled",
  };
  return map[value] || value;
}


function productCreatedAtValue(product: any) {
  const value = new Date(product.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export default function ImportedProducts() {
  const { products, stats, cleanup, pagination, filters: loaderFilters, filterOptions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const isBusy = navigation.state !== "idle";

  const [filters, setFilters] = useState<ProductFilters>({
    q: loaderFilters?.q || "",
    shopify: loaderFilters?.shopify || "all",
    status: loaderFilters?.status || "all",
    stock: loaderFilters?.stock || "all",
    sync: loaderFilters?.sync || "all",
    type: loaderFilters?.type || "all",
    filterName: loaderFilters?.filterName || "all",
    color: loaderFilters?.color || "all",
    gender: loaderFilters?.gender || "all",
    sizeMode: loaderFilters?.sizeMode || "all",
    audit: loaderFilters?.audit || "all",
  });
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [stockBatchLimit, setStockBatchLimit] = useState("8");
  const [gradualStockSync, setGradualStockSync] = useState<GradualStockSyncState>(initialGradualStockSyncState);
  const stopGradualStockSyncRef = useRef(false);

  useEffect(() => {
    setSelectedIds({});
  }, [pagination.page, pagination.pageSize]);

  useEffect(() => {
    setFilters({
      q: loaderFilters?.q || "",
      shopify: loaderFilters?.shopify || "all",
      status: loaderFilters?.status || "all",
      stock: loaderFilters?.stock || "all",
      sync: loaderFilters?.sync || "all",
      type: loaderFilters?.type || "all",
      filterName: loaderFilters?.filterName || "all",
      color: loaderFilters?.color || "all",
      gender: loaderFilters?.gender || "all",
      sizeMode: loaderFilters?.sizeMode || "all",
      audit: loaderFilters?.audit || "all",
    });
  }, [loaderFilters]);

  const rows = useMemo(() => {
    const prepared = (products || []).map((product: any) => {
      const availableSizes = displayAvailableSizes(product.variants);
      const hasStock = hasAvailableStock(product.variants);
      const type = normalizeFilterValue(displayProductType(product));
      const filterName = normalizeFilterValue(displayFilterName(product));
      const color = normalizeFilterValue(displayColor(product));
      const gender = normalizeFilterValue(displayTargetGender(product));
      const nameType = normalizeFilterValue(displayNameType(product));
      const title = displayTitle(product);
      const shopifyCreated = Boolean(product.shopifyProductGid);
      const hasPrice = Number(product.salePriceUah || 0) > 0;
      const hasImage = Boolean(product.imageUrl);
      const supplierUrl = normalizeString(product.supplierUrl).toLowerCase();
      const symbol = normalizeString(product.supplierSymbol || product.modelCode).toLowerCase();
      const brand = normalizeString(product.brand).toLowerCase();
      const duplicateKey = supplierUrl || (symbol ? `${brand}:${symbol}` : "");

      return {
        product,
        id: product.id,
        title,
        type,
        filterName,
        color,
        gender,
        nameType,
        availableSizes,
        hasStock,
        shopifyCreated,
        hasPrice,
        hasImage,
        duplicateKey,
        duplicateCount: 1,
        duplicateExtra: false,
        searchHaystack: ` ${[
          title,
          product.brand,
          product.supplierSymbol,
          product.modelCode,
          product.supplierUrl,
          type,
          filterName,
          color,
          gender,
          nameType,
          product.status,
          product.stockSourceStatus,
        ].filter(Boolean).join(" ")} `.toLowerCase(),
      };
    });

    const groups = new Map<string, typeof prepared>();
    for (const row of prepared) {
      if (!row.duplicateKey) continue;
      const group = groups.get(row.duplicateKey) || [];
      group.push(row);
      groups.set(row.duplicateKey, group as typeof prepared);
    }

    for (const group of groups.values()) {
      if (group.length <= 1) continue;
      const preferred = [...group].sort((a, b) => {
        const shopifyRank = Number(Boolean(b.product.shopifyProductGid)) - Number(Boolean(a.product.shopifyProductGid));
        if (shopifyRank !== 0) return shopifyRank;
        return productCreatedAtValue(a.product) - productCreatedAtValue(b.product);
      })[0];

      for (const row of group) {
        row.duplicateCount = group.length;
        row.duplicateExtra = row.id !== preferred.id;
      }
    }

    return prepared;
  }, [products]);

  const options = useMemo(() => ({
    statuses: filterOptions?.statuses?.length ? filterOptions.statuses : uniqueSorted(rows.map((row) => normalizeString(row.product.status))),
    stocks: filterOptions?.stocks?.length ? filterOptions.stocks : uniqueSorted(rows.map((row) => normalizeString(row.product.stockSourceStatus))),
    types: filterOptions?.types?.length ? filterOptions.types : uniqueSorted(rows.map((row) => row.type)),
    filterNames: filterOptions?.filterNames?.length ? filterOptions.filterNames : uniqueSorted(rows.map((row) => row.filterName)),
    colors: filterOptions?.colors?.length ? filterOptions.colors : uniqueSorted(rows.map((row) => row.color)),
    genders: filterOptions?.genders?.length ? filterOptions.genders : uniqueSorted(rows.map((row) => row.gender)),
  }), [filterOptions, rows]);

  // Server-side pagination/filtering already returns only the rows for the current view.
  // Do not filter the 50 loaded rows again on the client, otherwise filters can look
  // like they reset or hide valid rows when display-derived values differ from DB fields.
  const filteredRows = rows;

  const selectedCount = Object.values(selectedIds).filter(Boolean).length;
  const filteredIds = filteredRows.map((row) => row.id);

  function buildFilterParams(nextFilters: ProductFilters, nextPage = 1, nextPageSize = pagination.pageSize) {
    // Preserve Shopify embedded-app query params like shop/host/id_token.
    // Dropping them can open the generic Log in screen after applying filters.
    const params = new URLSearchParams(location.search);
    for (const key of PRODUCT_FILTER_QUERY_KEYS) params.delete(key);

    params.set("page", String(Math.max(1, nextPage)));
    params.set("pageSize", String(nextPageSize));

    const entries = Object.entries(nextFilters) as [keyof ProductFilters, string][];
    for (const [key, value] of entries) {
      const cleanValue = normalizeString(value);
      if (!cleanValue || cleanValue === "all") continue;
      params.set(key, cleanValue);
    }

    return params;
  }

  function pageUrl(nextPage: number, nextPageSize = pagination.pageSize) {
    const boundedPage = Math.max(1, Math.min(pagination.totalPages, nextPage));
    const params = buildFilterParams(filters, boundedPage, nextPageSize);
    return `${location.pathname}?${params.toString()}`;
  }

  function applyFilters(nextFilters = filters) {
    const params = buildFilterParams(nextFilters, 1, pagination.pageSize);
    setSelectedIds({});
    navigate(`${location.pathname}?${params.toString()}`);
  }

  function setFilter(name: keyof ProductFilters, value: string, autoApply = false) {
    const nextFilters = { ...filters, [name]: value };
    setFilters(nextFilters);
    if (autoApply) applyFilters(nextFilters);
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

  function clearSelection() {
    setSelectedIds({});
  }

  function stopGradualStockSync() {
    stopGradualStockSyncRef.current = true;
    setGradualStockSync((current) => ({
      ...current,
      running: false,
      message: current.message || "Gradual stock sync stopped.",
    }));
  }

  async function startGradualStockSync() {
    if (gradualStockSync.running) return;

    const normalizedLimit = Math.max(1, Math.min(20, Number(stockBatchLimit || 8) || 8));
    const startedAt = new Date().toISOString();
    stopGradualStockSyncRef.current = false;

    let processedTotal = 0;
    let syncedTotal = 0;
    let skippedTotal = 0;
    let failedTotal = 0;
    const collectedErrors: string[] = [];

    setGradualStockSync({
      running: true,
      startedAt,
      processed: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
      remaining: null,
      message: `Starting gradual stock sync by ${normalizedLimit} products per batch...`,
      errors: [],
    });

    try {
      while (!stopGradualStockSyncRef.current) {
        const formData = new FormData();
        formData.set("intent", "sync_all_stock_batch");
        formData.set("stockBatchLimit", String(normalizedLimit));
        formData.set("startedAt", startedAt);

        const response = await fetch(`/api/gradual-stock-sync-batch${window.location.search}`, {
          method: "POST",
          body: formData,
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "ParserVoGradualStockSync",
          },
        });

        const contentType = response.headers.get("content-type") || "";
        const rawText = await response.text();

        if (!contentType.includes("application/json")) {
          const preview = rawText.replace(/\s+/g, " ").slice(0, 240);
          throw new Error(
            `Stock sync endpoint returned non-JSON response (${response.status}). `
            + `This usually means the new API route is not deployed yet, the Shopify session expired, or Vercel returned an HTML error page. `
            + `Open ParserVo again from Shopify Admin, press Ctrl+F5, and retry. Response preview: ${preview}`,
          );
        }

        let data: ActionData;
        try {
          data = JSON.parse(rawText) as ActionData;
        } catch (parseError) {
          throw new Error(`Stock sync endpoint returned invalid JSON: ${rawText.slice(0, 240)}`);
        }

        if (!response.ok || data.error) {
          throw new Error(data.error || `Request failed with status ${response.status}`);
        }

        const batch = data.batch;
        if (!batch) {
          throw new Error("Server did not return batch sync progress.");
        }

        processedTotal += batch.processed;
        syncedTotal += batch.synced;
        skippedTotal += batch.skipped;
        failedTotal += batch.failed;
        if (data.errors?.length) collectedErrors.push(...data.errors);
        const shouldStop = stopGradualStockSyncRef.current;

        setGradualStockSync({
          running: !batch.done && !shouldStop,
          startedAt,
          processed: processedTotal,
          synced: syncedTotal,
          skipped: skippedTotal,
          failed: failedTotal,
          remaining: batch.remaining,
          message: shouldStop
            ? `Gradual stock sync stopped. Processed: ${processedTotal}. Remaining: ${batch.remaining}.`
            : batch.done
              ? `Gradual stock sync finished. Processed: ${processedTotal}. Synced: ${syncedTotal}. Skipped: ${skippedTotal}. Failed: ${failedTotal}.`
              : `Synced batch. Processed: ${processedTotal}. Remaining: ${batch.remaining}. Next batch will start automatically...`,
          errors: collectedErrors.slice(-20),
        });

        if (shouldStop || batch.done || batch.remaining <= 0) break;

        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGradualStockSync((current) => ({
        ...current,
        running: false,
        message: `Gradual stock sync stopped with error: ${message}`,
        errors: [...current.errors, message].slice(-20),
      }));
    }
  }

  function resetFilters() {
    const cleanFilters: ProductFilters = {
      q: "",
      shopify: "all",
      status: "all",
      stock: "all",
      sync: "all",
      type: "all",
      filterName: "all",
      color: "all",
      gender: "all",
      sizeMode: "all",
      audit: "all",
    };
    setFilters(cleanFilters);
    const params = buildFilterParams(cleanFilters, 1, pagination.pageSize);
    setSelectedIds({});
    navigate(`${location.pathname}?${params.toString()}`);
  }

  return (
    <main className="app-page app-page-wide">
      <header className="app-header">
        <div>
          <h1 className="app-title">Imported Products</h1>
          <p className="app-subtitle">Импортированные товары, проверка данных перед Shopify, фильтры, массовые действия и контроль синхронизации.</p>
        </div>
        <div className="button-row">
          <Link className="btn" to="/app/import">Import product</Link>
          <Link className="btn" to="/app/excel-import">Excel import</Link>
          <Link className="btn btn-primary" to="/app/stock-sync">Stock Sync Center</Link>
        </div>
      </header>

      {cleanup?.removed ? (
        <div className="notice notice-success">
          В Shopify были удалены товары, поэтому ParserVo автоматически убрал из базы приложения: {cleanup.removed}.
        </div>
      ) : null}

      {actionData?.message ? (
        <div className={actionData.ok ? "notice notice-success" : "notice notice-warning"}>
          <strong>{actionData.message}</strong>
          {actionData.errors?.length ? (
            <pre className="small" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{actionData.errors.join("\n")}</pre>
          ) : null}
        </div>
      ) : null}

      {actionData?.error ? <div className="notice notice-error"><strong>{actionData.error}</strong></div> : null}

      <section className="grid grid-4 compact-metrics">
        <div className="card">
          <div className="metric-label">Imported in app</div>
          <div className="metric-value">{stats.total}</div>
        </div>
        <div className="card">
          <div className="metric-label">Not created in Shopify</div>
          <div className="metric-value">{stats.notCreated}</div>
        </div>
        <div className="card">
          <div className="metric-label">Created in Shopify</div>
          <div className="metric-value">{stats.created}</div>
        </div>
        <div className="card">
          <div className="metric-label">Supplier sold out</div>
          <div className="metric-value">{stats.soldOut}</div>
        </div>
      </section>

      {products.length === 0 ? (
        <section className="card section-gap">
          <h2 className="card-title">No imported products yet</h2>
          <p className="muted">Сначала загрузи Excel и выкачай товары через расширение.</p>
          <Link className="btn btn-primary" to="/app/excel-import">Excel import</Link>
        </section>
      ) : (
        <Form method="post" action={`${location.pathname}${location.search}`}>
          {Object.keys(selectedIds).filter((id) => selectedIds[id]).map((id) => (
            <input key={id} type="hidden" name="selectedProductIds" value={id} />
          ))}

          <section className="card section-gap filters-card">
            <div className="filters-header">
              <div>
                <h2 className="card-title">Filters & review</h2>
                <p className="muted small">Сначала отфильтруй товары, потом выдели только нужные строки и выполни действие.</p>
              </div>
              <div className="button-row">
                <button className="btn btn-primary" type="button" onClick={() => applyFilters(filters)}>Apply filters</button>
                <button className="btn" type="button" onClick={() => setFilter("stock", "supplier_sold_out", true)}>Show sold out</button>
                <button className="btn" type="button" onClick={resetFilters}>Reset filters</button>
              </div>
            </div>

            <div className="filters-grid">
              <label>
                Search
                <input
                  type="search"
                  placeholder="title, SKU, brand, color, link..."
                  value={filters.q}
                  onChange={(event) => setFilter("q", event.currentTarget.value, false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyFilters({ ...filters, q: event.currentTarget.value });
                    }
                  }}
                />
              </label>
              <label>
                Shopify
                <select value={filters.shopify} onChange={(event) => setFilter("shopify", event.currentTarget.value)}>
                  <option value="all">All</option>
                  <option value="not_created">Not created</option>
                  <option value="created">Created</option>
                  <option value="duplicates">Duplicates</option>
                  <option value="duplicate_copies">Duplicate copies only</option>
                </select>
              </label>
              <label>
                Status
                <select value={filters.status} onChange={(event) => setFilter("status", event.currentTarget.value)}>
                  <option value="all">All</option>
                  {options.statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
                </select>
              </label>
              <label>
                Stock
                <select value={filters.stock} onChange={(event) => setFilter("stock", event.currentTarget.value)}>
                  <option value="all">All</option>
                  {options.stocks.map((value) => <option key={value} value={value}>{stockStatusLabel(value)}</option>)}
                </select>
              </label>
              <label>
                Sync
                <select value={filters.sync} onChange={(event) => setFilter("sync", event.currentTarget.value)}>
                  <option value="all">All</option>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label>
                Size mode
                <select value={filters.sizeMode} onChange={(event) => setFilter("sizeMode", event.currentTarget.value)}>
                  <option value="all">All</option>
                  <option value="with_size">With sizes</option>
                  <option value="no_size">No size / UNI</option>
                  <option value="sold_out">No supplier stock</option>
                </select>
              </label>
              <label>
                Type
                <select value={filters.type} onChange={(event) => setFilter("type", event.currentTarget.value)}>
                  <option value="all">All</option>
                  {options.types.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>
                filter_name
                <select value={filters.filterName} onChange={(event) => setFilter("filterName", event.currentTarget.value)}>
                  <option value="all">All</option>
                  {options.filterNames.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>
                Color
                <select value={filters.color} onChange={(event) => setFilter("color", event.currentTarget.value)}>
                  <option value="all">All</option>
                  {options.colors.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>
                Target gender
                <select value={filters.gender} onChange={(event) => setFilter("gender", event.currentTarget.value)}>
                  <option value="all">All</option>
                  {options.genders.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>
                Audit quick filter
                <select value={filters.audit} onChange={(event) => setFilter("audit", event.currentTarget.value)}>
                  <option value="all">All</option>
                  <option value="duplicates">Duplicates</option>
                  <option value="duplicate_copies">Duplicate copies only</option>
                  <option value="missing_color">Missing color</option>
                  <option value="missing_price">Missing price</option>
                  <option value="missing_image">Missing image</option>
                  <option value="supplier_sold_out">Supplier sold out</option>
                </select>
              </label>
            </div>
          </section>

          <section className="bulk-toolbar section-gap">
            <div className="bulk-summary">
              <strong>Page: {pagination.page} / {pagination.totalPages}</strong>
              <span className="muted"> · {pagination.from}–{pagination.to} of {pagination.totalProducts}</span>
              <span className="bulk-divider" />
              <strong>Shown on page: {filteredRows.length}</strong>
              <span className="muted">/ {rows.length}</span>
              <span className="bulk-divider" />
              <strong>Selected: {selectedCount}</strong>
            </div>

            <div className="button-row">
              <button className="btn" type="button" onClick={() => setRowsSelected(filteredIds, true)}>Select filtered</button>
              <button className="btn" type="button" onClick={() => setRowsSelected(filteredRows.filter((row) => !row.shopifyCreated).map((row) => row.id), true)}>Select not-created</button>
              <button className="btn" type="button" onClick={() => setRowsSelected(filteredRows.filter((row) => row.duplicateExtra).map((row) => row.id), true)}>Select duplicate copies</button>
              <button className="btn" type="button" onClick={() => setRowsSelected(filteredRows.filter((row) => row.product.stockSourceStatus === "supplier_sold_out").map((row) => row.id), true)}>Select sold out</button>
              <button className="btn" type="button" onClick={clearSelection}>Clear selection</button>
            </div>

            <div className="button-row">
              <button className="btn btn-primary" type="submit" name="intent" value="create_selected_draft" disabled={isBusy || selectedCount === 0}>Create selected Draft</button>
              <button
                className="btn"
                type="submit"
                name="intent"
                value="create_selected_active"
                disabled={isBusy || selectedCount === 0}
                onClick={(event) => {
                  if (!confirm(`Создать выбранные товары сразу Active в Shopify? Выбрано: ${selectedCount}`)) event.preventDefault();
                }}
              >
                Create selected Active
              </button>
              <button className="btn" type="submit" name="intent" value="enable_selected_sync" disabled={isBusy || selectedCount === 0}>Enable sync</button>
              <button className="btn" type="submit" name="intent" value="disable_selected_sync" disabled={isBusy || selectedCount === 0}>Disable sync</button>
              <button className="btn" type="submit" name="intent" value="sync_selected_category_meta" disabled={isBusy || selectedCount === 0}>Sync category meta</button>
              <button
                className="btn btn-danger"
                type="submit"
                name="intent"
                value="delete_selected"
                disabled={isBusy || selectedCount === 0}
                onClick={(event) => {
                  if (!confirm(`Удалить выбранные товары из ParserVo и Shopify, если они созданы? Выбрано: ${selectedCount}`)) event.preventDefault();
                }}
              >
                Delete selected
              </button>
            </div>

            <div className="button-row stock-queue-controls">
              <Link className="btn btn-primary" to="/app/stock-sync">Open Stock Sync Center</Link>
              <span className="small muted">Наличие теперь синхронизируется только на отдельной странице Stock Sync Center, чтобы не путаться и видеть все логи в одном месте.</span>
            </div>
          </section>


          <details className="card section-gap advanced-actions">
            <summary><strong>Advanced batch creation</strong> <span className="muted small">— создание следующих партий без ручного выбора</span></summary>
            <div className="button-row" style={{ marginTop: 12, alignItems: "center" }}>
              <label className="small muted" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 0 }}>
                Batch size
                <input name="batchLimit" type="number" min="1" max="500" defaultValue="50" style={{ width: 90 }} />
              </label>
              <button className="btn btn-primary" type="submit" name="intent" value="create_batch_draft" disabled={isBusy || stats.notCreated === 0}>Create next batch Draft</button>
              <button
                className="btn"
                type="submit"
                name="intent"
                value="create_batch_active"
                disabled={isBusy || stats.notCreated === 0}
                onClick={(event) => {
                  if (!confirm("Создать следующую партию товаров сразу Active?")) event.preventDefault();
                }}
              >
                Create next batch Active
              </button>
              <button className="btn" type="submit" name="intent" value="create_all_draft" disabled={isBusy || stats.notCreated === 0}>Create ALL not-created Draft</button>
              <button
                className="btn"
                type="submit"
                name="intent"
                value="create_all_active"
                disabled={isBusy || stats.notCreated === 0}
                onClick={(event) => {
                  if (!confirm("Создать ВСЕ не созданные товары сразу Active?")) event.preventDefault();
                }}
              >
                Create ALL not-created Active
              </button>
            </div>
          </details>

          <section className="card section-gap table-card">
            <div className="table-topline table-topline-paginated">
              <div>
                <strong>Products</strong>
                <span className="muted small">Проверяй Type, Color, filter_name, Target gender, Name type и цены до создания товара в Shopify.</span>
              </div>
              <div className="pagination-controls">
                <span className="muted small">Rows:</span>
                {PRODUCT_PAGE_SIZE_OPTIONS.map((size) => (
                  <Link
                    key={size}
                    className={size === pagination.pageSize ? "btn btn-primary btn-small" : "btn btn-small"}
                    to={pageUrl(1, size)}
                  >
                    {size}
                  </Link>
                ))}
                <span className="pagination-divider" />
                <Link className="btn btn-small" to={pageUrl(1)} aria-disabled={pagination.page <= 1}>First</Link>
                <Link className="btn btn-small" to={pageUrl(pagination.page - 1)} aria-disabled={pagination.page <= 1}>Prev</Link>
                <span className="small"><strong>{pagination.page}</strong> / {pagination.totalPages}</span>
                <Link className="btn btn-small" to={pageUrl(pagination.page + 1)} aria-disabled={pagination.page >= pagination.totalPages}>Next</Link>
                <Link className="btn btn-small" to={pageUrl(pagination.totalPages)} aria-disabled={pagination.page >= pagination.totalPages}>Last</Link>
              </div>
            </div>
            <div className="table-wrap products-table-wrap">
              <table className="compact-table">
                <thead>
                  <tr>
                    <th className="sticky-select-cell">Select</th>
                    <th className="sticky-image-cell">Image</th>
                    <th>Vendor</th>
                    <th className="sticky-title-cell">Title</th>
                    <th>Type</th>
                    <th>Color</th>
                    <th>filter_name</th>
                    <th>Target gender</th>
                    <th>Name type</th>
                    <th>Supplier</th>
                    <th>Cost zł</th>
                    <th>Price</th>
                    <th>Compare-at price</th>
                    <th>Available sizes</th>
                    <th>Shopify</th>
                    <th>Status</th>
                    <th>Stock</th>
                    <th>Sync</th>
                    <th className="sticky-actions-cell">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => {
                    const product = row.product;
                    const shopifyAdminUrl = product.shopifyProductId
                      ? `https://admin.shopify.com/store/${product.shop.replace(".myshopify.com", "")}/products/${product.shopifyProductId}`
                      : "";

                    return (
                      <tr key={product.id} className={row.duplicateExtra ? "row-warning" : undefined}>
                        <td className="sticky-select-cell">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedIds[product.id])}
                            onChange={(event) => setRowsSelected([product.id], event.currentTarget.checked)}
                          />
                        </td>
                        <td className="sticky-image-cell">
                          {product.imageUrl ? (
                            <img className="product-image" src={product.imageUrl} alt={row.title} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{product.brand || "—"}</td>
                        <td className="title-cell sticky-title-cell">
                          <strong>{row.title}</strong><br />
                          <span className="muted small">{product.supplierSymbol || product.modelCode || "No symbol"}</span>
                          {row.duplicateCount > 1 ? (
                            <><br /><span className={row.duplicateExtra ? "badge badge-red" : "badge badge-yellow"}>{row.duplicateExtra ? "duplicate copy" : `duplicate group ×${row.duplicateCount}`}</span></>
                          ) : null}
                        </td>
                        <td>{row.type}</td>
                        <td>{row.color}</td>
                        <td>{row.filterName}</td>
                        <td>{row.gender}</td>
                        <td>{row.nameType}</td>
                        <td>
                          <strong>{product.supplierName}</strong><br />
                          <a href={product.supplierUrl} target="_blank" rel="noreferrer">Open supplier</a>
                        </td>
                        <td>
                          {formatMoney(product.supplierPrice, 2)} {product.supplierCurrency || "PLN"}
                          {product.supplierOldPrice ? (
                            <><br /><span className="muted small">old {formatMoney(product.supplierOldPrice, 2)} {product.supplierCurrency || "PLN"}</span></>
                          ) : null}
                        </td>
                        <td>{formatMoney(product.salePriceUah)} UAH</td>
                        <td>{product.compareAtPriceUah ? `${formatMoney(product.compareAtPriceUah)} UAH` : "—"}</td>
                        <td>{row.availableSizes || (row.hasStock ? <span className="muted">No size / UNI</span> : <span className="badge badge-yellow">Sold out</span>)}</td>
                        <td>
                          {product.shopifyProductGid ? (
                            <>
                              <span className="badge badge-green">created</span><br />
                              {shopifyAdminUrl ? <a href={shopifyAdminUrl} target="_blank" rel="noreferrer">Open in Shopify</a> : null}
                            </>
                          ) : (
                            <span className="badge badge-yellow">not created</span>
                          )}
                        </td>
                        <td><span className={statusBadgeClass(product.status)}>{product.status}</span></td>
                        <td><span className={statusBadgeClass(product.stockSourceStatus)}>{product.stockSourceStatus}</span></td>
                        <td>
                          <span className={product.syncEnabled ? "badge badge-green" : "badge badge-yellow"}>
                            {product.syncEnabled ? "enabled" : "disabled"}
                          </span><br />
                          <span className="small muted">
                            {product.lastSyncedAt ? new Date(product.lastSyncedAt).toLocaleString() : "Never synced"}
                          </span>
                        </td>
                        <td className="sticky-actions-cell">
                          <div className="row-actions">
                            {!product.shopifyProductGid ? (
                              <>
                                <button className="btn btn-primary btn-small" type="submit" name="rowAction" value={`create_shopify_draft:${product.id}`} disabled={isBusy}>Create Draft</button>
                                <button
                                  className="btn btn-small"
                                  type="submit"
                                  name="rowAction"
                                  value={`create_shopify_active:${product.id}`}
                                  disabled={isBusy}
                                  onClick={(event) => {
                                    if (!confirm("Создать этот товар сразу Active?")) event.preventDefault();
                                  }}
                                >
                                  Create Active
                                </button>
                              </>
                            ) : (
                              <>
                                <button className="btn btn-small" type="submit" name="rowAction" value={`sync_now:${product.id}`} disabled={isBusy}>Sync stock</button>
                                <button className="btn btn-small" type="submit" name="rowAction" value={`sync_category_meta:${product.id}`} disabled={isBusy}>Sync meta</button>
                              </>
                            )}

                            {product.syncEnabled ? (
                              <button className="btn btn-small" type="submit" name="rowAction" value={`disable_sync:${product.id}`} disabled={isBusy}>Disable sync</button>
                            ) : (
                              <button className="btn btn-small" type="submit" name="rowAction" value={`enable_sync:${product.id}`} disabled={isBusy}>Enable sync</button>
                            )}

                            <button
                              className="btn btn-danger btn-small"
                              type="submit"
                              name="rowAction"
                              value={`delete_product:${product.id}`}
                              disabled={isBusy}
                              onClick={(event) => {
                                if (!confirm("Удалить этот товар из приложения и Shopify, если он уже создан?")) event.preventDefault();
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pagination-footer">
              <div className="muted small">
                Loaded only {pagination.loaded} products on this page. This keeps ParserVo fast with large catalogs.
              </div>
              <div className="pagination-controls">
                <Link className="btn btn-small" to={pageUrl(pagination.page - 1)} aria-disabled={pagination.page <= 1}>Prev</Link>
                <span className="small"><strong>{pagination.page}</strong> / {pagination.totalPages}</span>
                <Link className="btn btn-small" to={pageUrl(pagination.page + 1)} aria-disabled={pagination.page >= pagination.totalPages}>Next</Link>
              </div>
            </div>
          </section>
        </Form>
      )}
    </main>
  );
}
