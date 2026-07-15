import crypto from "node:crypto";

import db from "../db.server";
import { detectShopifyCategoryPath, resolveShopifyTaxonomyCategory } from "./shopify-taxonomy.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type ProductStatus = "DRAFT" | "ACTIVE";

type ImportedVariantForShopify = {
  id: string;
  size: string;
  supplierSizeLabel?: string | null;
  available: boolean;
  sku?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
};

type ShopifyLocation = {
  id: string;
  name: string;
  isActive?: boolean;
};

type ShopifyVariantNode = {
  id: string;
  title?: string | null;
  sku?: string | null;
  inventoryQuantity?: number | null;
  selectedOptions?: Array<{ name: string; value: string }>;
  inventoryItem?: { id: string } | null;
};

type ShopifyGraphqlUserError = {
  code?: string;
  field?: string[] | string | null;
  message: string;
};

export class ShopifyProductSyncError extends Error {
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ShopifyProductSyncError";
    this.details = details;
  }
}

async function shopifyGraphql<T>(
  admin: AdminClient,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (!response.ok) {
    throw new ShopifyProductSyncError(`Shopify API HTTP ${response.status}`, json);
  }

  if (json.errors?.length) {
    throw new ShopifyProductSyncError(
      json.errors.map((error: { message?: string }) => error.message || "Unknown GraphQL error").join(" | "),
      json.errors,
    );
  }

  return json.data as T;
}

function throwUserErrors(context: string, errors: ShopifyGraphqlUserError[] | undefined) {
  if (!errors || errors.length === 0) return;

  throw new ShopifyProductSyncError(
    `${context}: ${errors.map((error) => error.message).join(" | ")}`,
    errors,
  );
}

function legacyIdFromGid(gid: string | null | undefined) {
  if (!gid) return "";
  return gid.split("/").pop() || gid;
}

function toMoney(value: number | null | undefined) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue.toFixed(2) : "0.00";
}

function safeText(value: string | null | undefined) {
  return String(value || "").trim();
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => safeText(value))
        .filter(Boolean),
    ),
  );
}

function slugifyFilename(value: string) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ\-_.]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "parservo-product";
}

const ALPHA_SIZE_ORDER = ["XXXXS", "XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];

function normalizeSizeLabel(value: string | null | undefined) {
  return safeText(value).replace(",", ".").toUpperCase();
}

function sizeSortKey(value: string | null | undefined) {
  const normalized = normalizeSizeLabel(value);
  const numeric = Number(normalized.replace(/[^0-9.]/g, ""));

  if (/^\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(numeric)) {
    return { group: 1, rank: numeric, label: normalized };
  }

  const alphaRank = ALPHA_SIZE_ORDER.indexOf(normalized);
  if (alphaRank >= 0) {
    return { group: 2, rank: alphaRank, label: normalized };
  }

  return { group: 3, rank: 9999, label: normalized };
}

function compareSizes(a: string | null | undefined, b: string | null | undefined) {
  const left = sizeSortKey(a);
  const right = sizeSortKey(b);

  if (left.group !== right.group) return left.group - right.group;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.label.localeCompare(right.label, "uk");
}

function sortVariantsForShopify<T extends { size?: string | null; supplierSizeLabel?: string | null }>(variants: T[]) {
  return [...variants].sort((a, b) => compareSizes(a.size || a.supplierSizeLabel, b.size || b.supplierSizeLabel));
}

function buildProductTitle(product: { brand?: string | null; title?: string | null; originalTitle?: string | null }) {
  const brand = safeText(product.brand);
  const originalTitle = safeText(product.originalTitle);
  const fallbackTitle = safeText(product.title);
  const baseTitle = originalTitle || fallbackTitle;

  if (!baseTitle) return brand || "ParserVo product";
  if (!brand) return baseTitle;
  if (baseTitle.toLowerCase().startsWith(brand.toLowerCase())) return baseTitle;

  return `${brand} ${baseTitle}`.replace(/\s+/g, " ").trim();
}

function supplierHandleFromUrl(value: string | null | undefined) {
  const rawUrl = safeText(value);

  try {
    const url = new URL(rawUrl);
    const lastPathPart = url.pathname.split("/").filter(Boolean).pop() || "";
    return sanitizeHandle(lastPathPart);
  } catch {
    const lastPathPart = rawUrl.split("?")[0].split("/").filter(Boolean).pop() || "";
    return sanitizeHandle(lastPathPart);
  }
}

function sanitizeHandle(value: string) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 255);
}

function translateMaterialUa(value: string | null | undefined) {
  const material = safeText(value);
  if (!material) return "";

  const replacements: Array<[RegExp, string]> = [
    [/calfskin|calf leather/gi, "теляча шкіра"],
    [/cotton/gi, "бавовна"],
    [/leather/gi, "шкіра"],
    [/wool/gi, "вовна"],
    [/silk/gi, "шовк"],
    [/polyester/gi, "поліестер"],
    [/polyamide/gi, "поліамід"],
    [/nylon/gi, "нейлон"],
    [/elastane|spandex/gi, "еластан"],
    [/rubber/gi, "гума"],
    [/viscose/gi, "віскоза"],
    [/linen/gi, "льон"],
    [/cashmere/gi, "кашемір"],
  ];

  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), material);
}

function categoryLower(product: { categoryUa?: string | null; productType?: string | null; category?: string | null }) {
  return safeText(product.categoryUa || product.productType || product.category || "товар").toLowerCase();
}

function productPhraseUa(category: string) {
  const normalized = category.toLowerCase();

  if (/кросівки|черевики|лофери|сандалі|туфлі|шльопанці|ботильйони/.test(normalized)) return `Оригінальні ${normalized}`;
  if (/футболка|сорочка|куртка|сукня|сумка|спідниця/.test(normalized)) return `Оригінальна ${normalized}`;
  if (/поло|пальто|худі/.test(normalized)) return `Оригінальне ${normalized}`;
  if (/штани|джинси|шорти/.test(normalized)) return `Оригінальні ${normalized}`;

  return "Оригінальний товар";
}

function removeBrandFromTitle(title: string, brand: string) {
  if (!brand) return title;
  return title.replace(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"), "").trim();
}

function buildModelName(product: { brand?: string | null; title?: string | null; originalTitle?: string | null; categoryUa?: string | null }) {
  const brand = safeText(product.brand);
  const base = removeBrandFromTitle(safeText(product.originalTitle || product.title), brand);
  const withoutCategoryWords = base
    .replace(/\b(sneakers?|shoes?|trainers?|boots?|sandals?|pumps?|loafers?|shirt|t-shirt|tee|polo|hoodie|sweatshirt|jacket|coat|dress|bag|skirt|trousers|pants|jeans|shorts)\b/gi, " ")
    .replace(/\b(black|white|grey|gray|blue|navy|beige|brown|green|red|pink|purple|yellow|orange|silver|gold)\b/gi, " ")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutCategoryWords;
}

function limitText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  const sliced = normalized.slice(0, maxLength + 1);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > 50 ? sliced.slice(0, lastSpace) : normalized.slice(0, maxLength)).replace(/[,.\s-]+$/g, "");
}

function buildSeoTitle(product: {
  brand?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  category?: string | null;
}) {
  const brand = safeText(product.brand);
  const model = buildModelName(product);
  const category = categoryLower(product);
  const full = `${brand}${model ? ` ${model}` : ""} ${category} — купити в Україні | CINQ`.replace(/\s+/g, " ").trim();

  if (full.length <= 70) return full;

  const shorter = `${brand} ${category} — купити в Україні | CINQ`.replace(/\s+/g, " ").trim();
  return limitText(shorter.length <= 70 ? shorter : full, 70);
}

function buildSeoDescription(product: {
  brand?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  category?: string | null;
}) {
  const brand = safeText(product.brand);
  const model = buildModelName(product);
  const category = categoryLower(product);
  const phrase = productPhraseUa(category);
  const name = `${brand}${model ? ` ${model}` : ""}`.trim();
  const description = `${phrase}${name ? ` ${name}` : ""} у CINQ. Актуальна наявність, допомога з розміром і доставка по Україні. Позиції з України, Європи та США.`;

  return limitText(description, 160);
}

function stripWhyBuyBlock(value: string | null | undefined) {
  return safeText(value)
    .replace(/\b(?:Why\s+(?:buy|should\s+you\s+buy|is\s+this\s+product\s+worth\s+buying)\s*(?:this\s+product)?\??|Why\s+buy\s+this\s+product\??)[\s\S]*$/i, "")
    .replace(/\s*[•\u2022]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackTranslateFashionDescriptionUa(value: string | null | undefined, product?: {
  brand?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  colorUa?: string | null;
  color?: string | null;
  material?: string | null;
  composition?: string | null;
}) {
  const source = stripWhyBuyBlock(value);
  if (!source) return "";
  if (/[а-яіїєґ]/i.test(source)) return source;

  const brand = safeText(product?.brand || "бренду");
  const category = safeText(product?.categoryUa || product?.productType || "виріб").toLowerCase();
  const color = safeText(product?.colorUa || product?.color || "").toLowerCase();
  const material = translateMaterialUa(product?.material || product?.composition || (/cotton/i.test(source) ? "cotton" : ""));
  const details: string[] = [];

  if (/boxy fit/i.test(source)) details.push("крій boxy fit");
  else if (/regular fit|classic regular fit/i.test(source)) details.push("класичний прямий крій");
  else if (/relaxed fit|loose/i.test(source)) details.push("вільний крій");

  if (/short sleeves?/i.test(source)) details.push("короткі рукави");
  if (/long sleeves?/i.test(source)) details.push("довгі рукави");
  if (/crew neck|round neck|rounded crew neck/i.test(source)) details.push("кругла горловина");
  if (/ribbed/i.test(source)) details.push("оздоблення в рубчик");
  if (/embroider/i.test(source)) details.push("вишиті деталі");
  if (/logo patch/i.test(source)) details.push("логотип-патч");
  else if (/logo/i.test(source)) details.push("фірмовий логотип");

  const quoted = source.match(/[“\"]([^”\"]{6,80})[”\"]/);
  const inscription = quoted?.[1] || source.match(/(?:inscription|napis)\s*[–-]\s*([^.–]{6,100})/i)?.[1];
  const categoryTitle = category ? category.charAt(0).toUpperCase() + category.slice(1) : "Виріб";
  const first = `${categoryTitle}${brand ? ` ${brand}` : ""}${color ? ` у ${color} кольорі` : ""} — модель, описана постачальником як поєднання стриманої елегантності та сучасного підходу до класичних форм.`;
  const secondParts: string[] = [];
  if (details.length) secondParts.push(`Серед ключових особливостей: ${details.join(", ")}`);
  if (material) secondParts.push(`матеріал — ${material}`);
  const second = secondParts.length ? `${secondParts.join("; ")}.` : "Модель має акуратне виконання та продуману посадку для щоденного гардероба.";
  const third = inscription ? `Декоративний напис «${inscription.trim()}» підкреслює характер речі та впізнавану естетику бренду.` : "Деталі виробу підкреслюють фірмову естетику бренду.";

  return [first, second, third].join(" ").replace(/\s+/g, " ").trim();
}

function originalDescriptionToHtml(value: string) {
  const original = safeText(value);
  if (!original) return "";

  const normalized = original
    .replace(/\r/g, "")
    .replace(/\s*•\s*/g, "\n• ")
    .replace(/\s+(Why buy this product\??)/gi, "\n$1")
    .replace(/\s+(Premium-quality|Elegant,|Unique |Perfectly )/g, "\n• $1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const blocks = normalized.split(/\n{2,}|(?=\nWhy buy this product\??)/i).map((block) => block.trim()).filter(Boolean);
  const html: string[] = [];

  for (const block of blocks) {
    const lines = block.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const titleLine = lines[0];
    const bulletLines = lines.filter((line) => line.startsWith("•"));
    const regularLines = lines.filter((line) => !line.startsWith("•"));

    if (/^Why buy this product\??$/i.test(titleLine)) {
      html.push("<h3>Why buy this product?</h3>");
      if (bulletLines.length > 0) {
        html.push("<ul>");
        for (const line of bulletLines) html.push(`<li>${escapeHtml(line.replace(/^•\s*/, ""))}</li>`);
        html.push("</ul>");
      }
      continue;
    }

    if (regularLines.length > 0) {
      html.push(`<p>${escapeHtml(regularLines.join(" "))}</p>`);
    }

    if (bulletLines.length > 0) {
      html.push("<ul>");
      for (const line of bulletLines) html.push(`<li>${escapeHtml(line.replace(/^•\s*/, ""))}</li>`);
      html.push("</ul>");
    }
  }

  return html.join("\n");
}

function buildDescriptionHtml(product: {
  brand?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  description?: string | null;
  originalDescription?: string | null;
  composition?: string | null;
  material?: string | null;
  colorUa?: string | null;
  color?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  genderUa?: string | null;
  modelCode?: string | null;
  supplierSymbol?: string | null;
}) {
  const primaryDescription = stripWhyBuyBlock(product.description || "");
  const fallbackSource = primaryDescription || stripWhyBuyBlock(product.originalDescription || "");
  const localizedDescription = /[а-яіїєґ]/i.test(fallbackSource)
    ? fallbackSource
    : fallbackTranslateFashionDescriptionUa(fallbackSource, product);
  const originalHtml = originalDescriptionToHtml(localizedDescription);
  if (originalHtml) return originalHtml;

  const rows = [
    ["Brand", product.brand],
    ["Category", product.categoryUa || product.productType],
    ["Color", product.color || product.colorUa],
    ["Material", product.material],
    ["Composition", product.composition],
    ["Gender", product.genderUa],
    ["SKU", product.modelCode || product.supplierSymbol],
  ].filter(([, value]) => safeText(value));

  if (rows.length === 0) return "";

  const parts = ["<h3>Details</h3>", "<ul>"];
  for (const [label, value] of rows) {
    parts.push(`<li><strong>${escapeHtml(String(label))}:</strong> ${escapeHtml(String(value))}</li>`);
  }
  parts.push("</ul>");
  return parts.join("\n");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseImages(imagesJson: string | null | undefined, fallbackImageUrl?: string | null) {
  const images: string[] = [];

  try {
    const parsed = JSON.parse(imagesJson || "[]");
    if (Array.isArray(parsed)) {
      for (const image of parsed) {
        if (typeof image === "string" && /^https?:\/\//i.test(image)) images.push(image);
      }
    }
  } catch {
    // ignore broken JSON
  }

  if (fallbackImageUrl && /^https?:\/\//i.test(fallbackImageUrl)) images.unshift(fallbackImageUrl);

  return uniqueStrings(images).slice(0, 12);
}

function buildTags(_product: {
  supplierName: string;
  brand?: string | null;
  categoryUa?: string | null;
  category?: string | null;
  productType?: string | null;
  genderUa?: string | null;
}) {
  return ["full_payment", "Vitkac"];
}

async function getLocations(admin: AdminClient): Promise<ShopifyLocation[]> {
  const data = await shopifyGraphql<{
    locations: { nodes: ShopifyLocation[] };
  }>(
    admin,
    `#graphql
    query ParserVoLocations {
      locations(first: 25) {
        nodes {
          id
          name
          isActive
        }
      }
    }`,
  );

  return data.locations.nodes || [];
}

export async function getShopifyLocations(admin: AdminClient) {
  return getLocations(admin);
}

function normalizeLocationGid(value: string | null | undefined) {
  const raw = safeText(value);
  if (!raw) return "";
  if (raw.startsWith("gid://shopify/Location/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Location/${raw}`;
  return "";
}

function isAccessDeniedToLocations(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /access denied.*locations field|locations field/i.test(message);
}

export async function resolveShopifyLocationId(
  admin: AdminClient,
  preferredLocationId?: string | null,
) {
  const normalized = normalizeLocationGid(preferredLocationId);
  if (normalized) {
    return { locationId: normalized, locationName: "Saved location" };
  }

  try {
    const locations = await getLocations(admin);
    const selectedLocation = locations.find((location) => location.isActive !== false) || locations[0];

    if (!selectedLocation) {
      throw new ShopifyProductSyncError("В Shopify не найдена локация склада. Создай Location в Shopify Admin или вставь Location ID в Settings.");
    }

    return { locationId: selectedLocation.id, locationName: selectedLocation.name };
  } catch (error) {
    if (isAccessDeniedToLocations(error)) {
      throw new ShopifyProductSyncError(
        "Нет доступа к Shopify locations. Обнови scopes и переустанови приложение, либо вставь Location ID вручную в Settings.",
        error instanceof ShopifyProductSyncError ? error.details : error,
      );
    }

    throw error;
  }
}

async function tryResolveShopifyLocationId(
  admin: AdminClient,
  preferredLocationId?: string | null,
) {
  const normalized = normalizeLocationGid(preferredLocationId);
  if (normalized) {
    return { locationId: normalized, locationName: "Saved location" };
  }

  // Для переноса товара в Shopify локация не должна блокировать создание товара.
  // Если scope read_locations еще не выдан, создаем товар без начальных остатков,
  // а остатки синхронизируем отдельным шагом Stock Sync после обновления прав.
  try {
    return await resolveShopifyLocationId(admin, preferredLocationId);
  } catch (error) {
    return null;
  }
}

function buildSizeMap(variants: Array<{ id: string; size: string; supplierSizeLabel?: string | null }>) {
  const used = new Set<string>();

  return variants.map((variant, index) => {
    const base = safeText(variant.size) || safeText(variant.supplierSizeLabel) || `Size ${index + 1}`;
    let value = base;
    let suffix = 2;

    while (used.has(value)) {
      value = `${base}-${suffix}`;
      suffix += 1;
    }

    used.add(value);
    return { importedVariantId: variant.id, size: value };
  });
}


function uniqueProductMetafields(
  metafields: Array<{ namespace: string; key: string; type: string; value: string | null | undefined }>,
) {
  const seen = new Set<string>();
  const result: Array<{ namespace: string; key: string; type: string; value: string }> = [];

  for (const metafield of metafields) {
    const value = safeText(metafield.value);
    if (!value) continue;

    const identity = `${metafield.namespace}.${metafield.key}`;
    if (seen.has(identity)) continue;

    seen.add(identity);
    result.push({ ...metafield, value });
  }

  return result;
}




type CategoryMetafieldTarget = {
  /** Product metafield key in namespace shopify, for example shopify.fabric */
  key: string;
  /** Name shown in Shopify Admin, used for logs */
  displayName: string;
  /** Possible taxonomy attribute names returned by TaxonomyCategory.attributes */
  attributeNames: string[];
  /** Standard metaobject definition types to try, in priority order */
  metaobjectTypes: string[];
  /** Values to write into the metafield */
  labels: string[];
};

type TaxonomyAttributeValue = {
  id: string;
  name: string;
};

type TaxonomyAttributeLookup = Map<string, TaxonomyAttributeValue[]>;

type CategoryMetafieldSyncResult = {
  attempted: number;
  synced: number;
  skipped: number;
  errors: string[];
};

type MetaobjectFieldDefinitionInfo = {
  key: string;
  name?: string | null;
  required?: boolean | null;
  type?: { name?: string | null; category?: string | null } | null;
};

type MetaobjectDefinitionInfo = {
  id: string;
  type: string;
  displayNameKey?: string | null;
  fieldDefinitions?: MetaobjectFieldDefinitionInfo[] | null;
};

function titleCaseEnglish(value: string | null | undefined) {
  return safeText(value)
    .toLowerCase()
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeAttributeName(value: string | null | undefined) {
  return safeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeAttributeValue(value: string | null | undefined) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueLabels(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => safeText(value)).filter(Boolean)));
}

function colorLabelForShopify(value: string | null | undefined) {
  const normalized = safeText(value).toUpperCase().replace(/\s+/g, " ").trim();
  const map: Record<string, string> = {
    BLACK: "Black",
    WHITE: "White",
    BEIGE: "Beige",
    BLUE: "Blue",
    BROWN: "Brown",
    GOLD: "Gold",
    GREEN: "Green",
    GREY: "Gray",
    GRAY: "Gray",
    NAVY: "Navy",
    "NAVY BLUE": "Navy",
    ORANGE: "Orange",
    PINK: "Pink",
    PURPLE: "Purple",
    RED: "Red",
    SILVER: "Silver",
    YELLOW: "Yellow",
    ЧОРНИЙ: "Black",
    БІЛИЙ: "White",
    БЕЖЕВИЙ: "Beige",
    БЛАКИТНИЙ: "Blue",
    СИНІЙ: "Blue",
    КОРИЧНЕВИЙ: "Brown",
    ЗЕЛЕНИЙ: "Green",
    СІРИЙ: "Gray",
    "ТЕМНО-СИНІЙ": "Navy",
    ПОМАРАНЧЕВИЙ: "Orange",
    РОЖЕВИЙ: "Pink",
    ФІОЛЕТОВИЙ: "Purple",
    ЧЕРВОНИЙ: "Red",
    СРІБЛЯСТИЙ: "Silver",
    ЖОВТИЙ: "Yellow",
  };

  return map[normalized] || map[normalized.split(/[\s/-]+/)[0]] || titleCaseEnglish(value);
}

function materialLabelForShopify(product: { material?: string | null; composition?: string | null; originalDescription?: string | null; description?: string | null }) {
  const source = `${product.material || ""} ${product.composition || ""} ${product.originalDescription || ""} ${product.description || ""}`;
  if (/cotton|бавовн/i.test(source)) return "Cotton";
  if (/calf|leather|шкір/i.test(source)) return "Leather";
  if (/wool|вовн/i.test(source)) return "Wool";
  if (/silk|шовк/i.test(source)) return "Silk";
  if (/cashmere|кашем/i.test(source)) return "Cashmere";
  if (/linen|льон/i.test(source)) return "Linen";
  if (/polyester|поліестер/i.test(source)) return "Polyester";
  if (/polyamide|nylon|поліамід|нейлон/i.test(source)) return "Nylon";
  if (/rubber|гума/i.test(source)) return "Rubber";
  return titleCaseEnglish(product.material || "");
}

function detectNeckline(product: { title?: string | null; originalTitle?: string | null; originalDescription?: string | null; description?: string | null; categoryUa?: string | null; productType?: string | null; category?: string | null }) {
  const source = `${product.title || ""} ${product.originalTitle || ""} ${product.originalDescription || ""} ${product.description || ""}`;
  if (/v[-\s]?neck/i.test(source)) return "V-neck";
  if (/crew neck|round neck|rounded crew neck|rounded neck|кругл/i.test(source)) return "Crew";
  if (/turtleneck|roll neck|high neck|гольф|висок/i.test(source)) return "Turtleneck";
  if (/collar|комір/i.test(source)) return "Collared";

  const category = safeText(product.categoryUa || product.productType || product.category).toLowerCase();
  if (/футболка|поло|t-shirt|polo/.test(category)) return "Crew";
  return "";
}

function detectSleeveLength(product: { title?: string | null; originalTitle?: string | null; originalDescription?: string | null; description?: string | null; categoryUa?: string | null; productType?: string | null; category?: string | null }) {
  const source = `${product.title || ""} ${product.originalTitle || ""} ${product.originalDescription || ""} ${product.description || ""}`;
  if (/long[-\s]?sleeve|long sleeve|довг/i.test(source)) return "Long";
  if (/short[-\s]?sleeve|short sleeve|t[-\s]?shirt|polo|коротк/i.test(source)) return "Short";

  const category = safeText(product.categoryUa || product.productType || product.category).toLowerCase();
  if (/футболка|поло|t-shirt|polo/.test(category)) return "Short";
  return "";
}

function detectTopLength(product: { title?: string | null; originalTitle?: string | null; originalDescription?: string | null; description?: string | null; categoryUa?: string | null; productType?: string | null; category?: string | null }) {
  const source = `${product.title || ""} ${product.originalTitle || ""} ${product.originalDescription || ""} ${product.description || ""}`;
  if (/cropped|crop|коротк/i.test(source)) return "Cropped";
  if (/longline|long line|подовж/i.test(source)) return "Long";
  const category = safeText(product.categoryUa || product.productType || product.category).toLowerCase();
  if (/футболка|поло|сорочка|светр|світшот|худі|t-shirt|polo|shirt|sweatshirt|hoodie/.test(category)) return "Medium";
  return "";
}

function detectClothingFeatures(product: { title?: string | null; originalTitle?: string | null; originalDescription?: string | null; description?: string | null }) {
  const source = `${product.title || ""} ${product.originalTitle || ""} ${product.originalDescription || ""} ${product.description || ""}`;
  const features: string[] = [];

  // Shopify taxonomy does not always have separate values for Logo / Embroidered.
  // For logo or embroidery items we use a valid generic entry instead of silently failing.
  if (/stretch|elastic|еласт/i.test(source)) features.push("Stretchable");
  if (/water[-\s]?resistant|водовід/i.test(source)) features.push("Water resistant");
  if (/wind[-\s]?proof|вітронепроник/i.test(source)) features.push("Windproof");
  if (/embroider|вишив|logo|логотип|patch|патч/i.test(source)) features.push("Other");

  return uniqueLabels(features);
}

function detectCareInstructions(product: { material?: string | null; composition?: string | null; originalDescription?: string | null; description?: string | null }) {
  const material = materialLabelForShopify(product);
  if (/Leather/i.test(material)) return ["Professional leather clean"];
  if (/Wool|Cashmere|Silk/i.test(material)) return ["Dry clean"];
  if (/Cotton|Polyester|Nylon|Linen/i.test(material)) return ["Machine wash cold"];
  return [];
}

function detectAgeGroup() {
  return "Adults";
}

function targetGenderLabel(product: { gender?: string | null; genderUa?: string | null; breadcrumbs?: string | null }) {
  const source = `${product.gender || ""} ${product.genderUa || ""} ${product.breadcrumbs || ""}`;
  if (/male|men|чолов|муж/i.test(source) && !/female|women|жін|жен/i.test(source)) return "Male";
  if (/female|women|жін|жен/i.test(source)) return "Female";
  return "Unisex";
}

function shopifySizeLabel(value: string | null | undefined) {
  const normalized = normalizeSizeLabel(value);
  const map: Record<string, string> = {
    XXXS: "Triple extra small (XXXS)",
    XXS: "Double extra small (XXS)",
    XS: "Extra small (XS)",
    S: "Small (S)",
    M: "Medium (M)",
    L: "Large (L)",
    XL: "Extra large (XL)",
    XXL: "Double extra large (XXL)",
    XXXL: "Triple extra large (XXXL)",
    XXXXL: "Quadruple extra large (XXXXL)",
  };
  return map[normalized] || safeText(value);
}

function buildNativeCategoryMetafieldTargets(product: {
  title?: string | null;
  originalTitle?: string | null;
  originalDescription?: string | null;
  description?: string | null;
  color?: string | null;
  colorUa?: string | null;
  gender?: string | null;
  genderUa?: string | null;
  breadcrumbs?: string | null;
  material?: string | null;
  composition?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  category?: string | null;
}, variants: Array<{ size?: string | null; supplierSizeLabel?: string | null; available?: boolean | null }>): CategoryMetafieldTarget[] {
  const availableSizes = sortVariantsForShopify(variants.filter((variant) => variant.available !== false))
    .map((variant) => shopifySizeLabel(variant.size || variant.supplierSizeLabel))
    .filter(Boolean);
  const color = colorLabelForShopify(product.color || product.colorUa);
  const fabric = materialLabelForShopify(product);
  const neckline = detectNeckline(product);
  const sleeveLength = detectSleeveLength(product);
  const topLength = detectTopLength(product);
  const clothingFeatures = detectClothingFeatures(product);
  const careInstructions = detectCareInstructions(product);
  const targetGender = targetGenderLabel(product);

  const targets: CategoryMetafieldTarget[] = [
    {
      key: "color-pattern",
      displayName: "Color",
      attributeNames: ["Color"],
      metaobjectTypes: ["shopify--color-pattern"],
      labels: uniqueLabels([color]),
    },
    {
      key: "size",
      displayName: "Size",
      attributeNames: ["Size", "Clothing size", "Alpha size", "Standard size"],
      metaobjectTypes: ["shopify--size"],
      labels: uniqueLabels(availableSizes),
    },
    {
      key: "fabric",
      displayName: "Fabric",
      attributeNames: ["Fabric", "Material"],
      metaobjectTypes: ["shopify--fabric", "shopify--material"],
      labels: uniqueLabels([fabric]),
    },
    {
      key: "age-group",
      displayName: "Age group",
      attributeNames: ["Age group"],
      metaobjectTypes: ["shopify--age-group"],
      labels: uniqueLabels([detectAgeGroup()]),
    },
    {
      key: "care-instructions",
      displayName: "Care instructions",
      attributeNames: ["Care instructions", "Care"],
      metaobjectTypes: ["shopify--care-instructions", "shopify--care-instruction"],
      labels: uniqueLabels(careInstructions),
    },
    {
      key: "clothing-features",
      displayName: "Clothing features",
      attributeNames: ["Clothing features", "Features"],
      metaobjectTypes: ["shopify--clothing-features", "shopify--clothing-feature"],
      labels: uniqueLabels(clothingFeatures),
    },
    {
      key: "neckline",
      displayName: "Neckline",
      attributeNames: ["Neckline"],
      metaobjectTypes: ["shopify--neckline"],
      labels: uniqueLabels([neckline]),
    },
    {
      key: "sleeve-length-type",
      displayName: "Sleeve length type",
      attributeNames: ["Sleeve length type", "Sleeve length"],
      metaobjectTypes: ["shopify--sleeve-length-type"],
      labels: uniqueLabels([sleeveLength]),
    },
    {
      key: "target-gender",
      displayName: "Target gender",
      attributeNames: ["Target gender", "Gender"],
      metaobjectTypes: ["shopify--target-gender"],
      labels: uniqueLabels([targetGender]),
    },
    {
      key: "top-length-type",
      displayName: "Top length type",
      attributeNames: ["Top length type", "Top length"],
      metaobjectTypes: ["shopify--top-length-type"],
      labels: uniqueLabels([topLength]),
    },
  ];

  return targets.filter((target) => target.labels.length > 0);
}

function buildCustomCategoryAttributeMetafields(product: {
  title?: string | null;
  originalTitle?: string | null;
  originalDescription?: string | null;
  description?: string | null;
  color?: string | null;
  colorUa?: string | null;
  gender?: string | null;
  genderUa?: string | null;
  breadcrumbs?: string | null;
  material?: string | null;
  composition?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  category?: string | null;
}, variants: Array<{ size?: string | null; supplierSizeLabel?: string | null; available?: boolean | null }>) {
  const targets = buildNativeCategoryMetafieldTargets(product, variants);
  const keyMap: Record<string, string> = {
    "color-pattern": "category_color",
    size: "category_size",
    fabric: "category_fabric",
    "age-group": "category_age_group",
    "care-instructions": "category_care_instructions",
    "clothing-features": "category_clothing_features",
    neckline: "category_neckline",
    "sleeve-length-type": "category_sleeve_length_type",
    "target-gender": "category_target_gender",
    "top-length-type": "category_top_length_type",
  };

  return targets.map((target) => ({
    namespace: "custom",
    key: keyMap[target.key] || `category_${target.key.replace(/-/g, "_")}`,
    type: "single_line_text_field",
    value: target.labels.join(", "),
  }));
}

async function getTaxonomyAttributeLookup(
  admin: AdminClient,
  taxonomyCategoryId: string | null | undefined,
): Promise<TaxonomyAttributeLookup> {
  const lookup: TaxonomyAttributeLookup = new Map();
  const categoryId = safeText(taxonomyCategoryId);
  if (!categoryId) return lookup;

  try {
    const data = await shopifyGraphql<{
      node?: {
        attributes?: {
          nodes?: Array<{
            __typename?: string;
            id?: string;
            name?: string;
            values?: { nodes?: TaxonomyAttributeValue[] };
          }>;
        };
      } | null;
    }>(
      admin,
      `#graphql
      query ParserVoTaxonomyCategoryAttributes($id: ID!) {
        node(id: $id) {
          ... on TaxonomyCategory {
            attributes(first: 100) {
              nodes {
                __typename
                id
                name
                ... on TaxonomyChoiceListAttribute {
                  values(first: 250) {
                    nodes {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { id: categoryId },
    );

    for (const attribute of data.node?.attributes?.nodes || []) {
      const key = normalizeAttributeName(attribute.name || "");
      if (!key) continue;
      lookup.set(key, attribute.values?.nodes || []);
    }
  } catch {
    return lookup;
  }

  return lookup;
}

function taxonomyLabelCandidates(target: CategoryMetafieldTarget, label: string) {
  const raw = safeText(label);
  const normalizedSize = normalizeSizeLabel(raw);
  const candidates = new Set<string>([raw]);

  const sizeAliasMap: Record<string, string[]> = {
    XXXS: ["Triple extra small", "Triple extra small (XXXS)", "3XS", "XXXS"],
    XXS: ["Double extra small", "Double extra small (XXS)", "2XS", "XXS"],
    XS: ["Extra small", "Extra small (XS)", "XS"],
    S: ["Small", "Small (S)", "S"],
    M: ["Medium", "Medium (M)", "M"],
    L: ["Large", "Large (L)", "L"],
    XL: ["Extra large", "Extra large (XL)", "XL"],
    XXL: ["Double extra large", "Double extra large (XXL)", "2XL", "XXL"],
    XXXL: ["Triple extra large", "Triple extra large (XXXL)", "3XL", "XXXL"],
    XXXXL: ["Quadruple extra large", "Quadruple extra large (XXXXL)", "4XL", "XXXXL"],
  };

  if (target.key === "size") {
    for (const alias of sizeAliasMap[normalizedSize] || []) candidates.add(alias);
    if (/\(([^)]+)\)/.test(raw)) candidates.add(raw.replace(/^(.+?)\s*\(([^)]+)\)$/, "$2"));
  }

  const valueAliasMap: Record<string, string[]> = {
    Gray: ["Grey", "Gray"],
    Navy: ["Navy blue", "Navy"],
    Cotton: ["Cotton"],
    Leather: ["Leather", "Genuine leather"],
    Nylon: ["Nylon", "Polyamide"],
    Adults: ["Adults", "Adult"],
    Male: ["Male", "Men", "Mens"],
    Female: ["Female", "Women", "Womens"],
    Unisex: ["Unisex"],
    Crew: ["Crew", "Crew neck", "Round neck"],
    "V-neck": ["V-neck", "V neck"],
    Short: ["Short", "Short sleeve", "Short sleeves"],
    Long: ["Long", "Long sleeve", "Long sleeves"],
    Medium: ["Medium", "Regular"],
    Cropped: ["Cropped", "Crop"],
    "Machine wash cold": ["Machine wash cold", "Machine washable", "Machine wash", "Cold wash"],
    "Dry clean": ["Dry clean", "Dry clean only"],
    "Professional leather clean": ["Professional leather clean", "Professional clean", "Leather clean"],
    Stretchable: ["Stretchable", "Stretch"],
    "Water resistant": ["Water resistant", "Water-resistant"],
    Windproof: ["Windproof", "Wind proof"],
    Other: ["Other"],
  };

  for (const alias of valueAliasMap[raw] || []) candidates.add(alias);

  return Array.from(candidates).filter(Boolean);
}

function findTaxonomyValueId(lookup: TaxonomyAttributeLookup, target: CategoryMetafieldTarget, label: string) {
  const attributeKeys = target.attributeNames.map((name) => normalizeAttributeName(name));
  const labels = taxonomyLabelCandidates(target, label);

  for (const attributeKey of attributeKeys) {
    const values = lookup.get(attributeKey) || [];
    if (values.length === 0) continue;

    for (const candidate of labels) {
      const normalizedLabel = normalizeAttributeValue(candidate);
      if (!normalizedLabel) continue;

      const exact = values.find((value) => normalizeAttributeValue(value.name) === normalizedLabel);
      if (exact?.id) return exact.id;

      const partial = values.find((value) => {
        const normalizedValue = normalizeAttributeValue(value.name);
        return normalizedValue.includes(normalizedLabel) || normalizedLabel.includes(normalizedValue);
      });

      if (partial?.id) return partial.id;
    }
  }

  // Last chance: search across all attributes. This helps if Shopify labels the attribute as
  // Material while the Admin card displays Fabric, or if the localized API name differs.
  for (const values of lookup.values()) {
    for (const candidate of labels) {
      const normalizedLabel = normalizeAttributeValue(candidate);
      const exact = values.find((value) => normalizeAttributeValue(value.name) === normalizedLabel);
      if (exact?.id) return exact.id;
    }
  }

  return "";
}

async function getMetaobjectDefinitionByType(admin: AdminClient, type: string): Promise<MetaobjectDefinitionInfo | null> {
  try {
    const data = await shopifyGraphql<{
      metaobjectDefinitionByType?: MetaobjectDefinitionInfo | null;
    }>(
      admin,
      `#graphql
      query ParserVoMetaobjectDefinitionByType($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          id
          type
          displayNameKey
          fieldDefinitions {
            key
            name
            required
            type {
              name
              category
            }
          }
        }
      }`,
      { type },
    );

    if (data.metaobjectDefinitionByType?.id) return data.metaobjectDefinitionByType;
  } catch {
    // Some older app/API configurations might not expose metaobjectDefinitionByType.
  }

  try {
    const data = await shopifyGraphql<{
      metaobjectDefinitions?: { nodes?: MetaobjectDefinitionInfo[] };
    }>(
      admin,
      `#graphql
      query ParserVoMetaobjectDefinitions($type: String!) {
        metaobjectDefinitions(first: 100, type: $type) {
          nodes {
            id
            type
            displayNameKey
            fieldDefinitions {
              key
              name
              required
              type {
                name
                category
              }
            }
          }
        }
      }`,
      { type },
    );

    const found = data.metaobjectDefinitions?.nodes?.find((definition) => definition.type === type);
    if (found?.id) return found;
  } catch {
    // Ignore and let the caller try another strategy.
  }

  return null;
}

async function ensureStandardMetaobjectDefinition(admin: AdminClient, type: string): Promise<MetaobjectDefinitionInfo | null> {
  const existing = await getMetaobjectDefinitionByType(admin, type);
  if (existing?.id) return existing;

  try {
    const enabled = await shopifyGraphql<{
      standardMetaobjectDefinitionEnable: {
        metaobjectDefinition?: MetaobjectDefinitionInfo | null;
        userErrors?: Array<{ field?: string[] | null; message: string; code?: string }>;
      };
    }>(
      admin,
      `#graphql
      mutation ParserVoEnableStandardMetaobjectDefinition($type: String!) {
        standardMetaobjectDefinitionEnable(type: $type) {
          metaobjectDefinition {
            id
            type
            displayNameKey
            fieldDefinitions {
              key
              name
              required
              type {
                name
                category
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      { type },
    );

    if (enabled.standardMetaobjectDefinitionEnable.metaobjectDefinition?.id) {
      return enabled.standardMetaobjectDefinitionEnable.metaobjectDefinition;
    }
  } catch {
    // Return null below.
  }

  return getMetaobjectDefinitionByType(admin, type);
}

async function ensureStandardProductMetafieldDefinition(admin: AdminClient, key: string) {
  const namespace = "shopify";

  try {
    const existing = await shopifyGraphql<{
      metafieldDefinition?: { id: string; namespace: string; key: string } | null;
    }>(
      admin,
      `#graphql
      query ParserVoProductMetafieldDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
        metafieldDefinition(identifier: $identifier) {
          id
          namespace
          key
        }
      }`,
      { identifier: { ownerType: "PRODUCT", namespace, key } },
    );

    if (existing.metafieldDefinition?.id) return { ok: true, alreadyEnabled: true, message: "enabled" };
  } catch {
    // Continue to standardMetafieldDefinitionEnable.
  }

  try {
    const data = await shopifyGraphql<{
      standardMetafieldDefinitionEnable: {
        createdDefinition?: { id: string; namespace: string; key: string } | null;
        userErrors?: Array<{ field?: string[] | null; message: string; code?: string }>;
      };
    }>(
      admin,
      `#graphql
      mutation ParserVoEnableStandardProductMetafieldDefinition($namespace: String!, $key: String!) {
        standardMetafieldDefinitionEnable(
          ownerType: PRODUCT,
          namespace: $namespace,
          key: $key,
          pin: true
        ) {
          createdDefinition {
            id
            namespace
            key
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      { namespace, key },
    );

    const errors = data.standardMetafieldDefinitionEnable.userErrors || [];
    if (data.standardMetafieldDefinitionEnable.createdDefinition?.id) return { ok: true, alreadyEnabled: false, message: "created" };
    if (errors.some((error) => /already|exist|taken|enabled/i.test(error.message))) return { ok: true, alreadyEnabled: true, message: "already enabled" };

    return { ok: false, alreadyEnabled: false, message: errors.map((error) => error.message).join(" | ") || "unknown error" };
  } catch (error) {
    return { ok: false, alreadyEnabled: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function findExistingMetaobjectByLabel(admin: AdminClient, type: string, label: string) {
  try {
    const data = await shopifyGraphql<{
      metaobjects: {
        nodes: Array<{
          id: string;
          displayName?: string | null;
          handle?: string | null;
          fields?: Array<{ key: string; value?: string | null }>; 
        }>;
      };
    }>(
      admin,
      `#graphql
      query ParserVoFindMetaobjects($type: String!) {
        metaobjects(type: $type, first: 250) {
          nodes {
            id
            displayName
            handle
            fields {
              key
              value
            }
          }
        }
      }`,
      { type },
    );

    const normalizedLabel = normalizeAttributeValue(label);
    const normalizedCandidates = taxonomyLabelCandidates({ key: "", displayName: "", attributeNames: [], metaobjectTypes: [], labels: [] }, label)
      .map((candidate) => normalizeAttributeValue(candidate));

    const matched = data.metaobjects.nodes.find((node) => {
      const nodeValues = [
        node.displayName,
        node.handle,
        ...(node.fields || []).map((field) => field.value),
      ].map((value) => normalizeAttributeValue(value));

      return nodeValues.some((value) => value === normalizedLabel || normalizedCandidates.includes(value));
    });

    return matched?.id || "";
  } catch {
    return "";
  }
}

function metaobjectFieldValueFor(
  definition: MetaobjectDefinitionInfo,
  field: MetaobjectFieldDefinitionInfo,
  label: string,
  taxonomyValueId: string,
  target: CategoryMetafieldTarget,
) {
  const key = safeText(field.key);
  const fieldName = normalizeAttributeName(`${field.key} ${field.name || ""}`);
  const typeName = safeText(field.type?.name).toLowerCase();
  const displayNameKey = safeText(definition.displayNameKey);

  if (displayNameKey && key === displayNameKey) return label;
  if (key === "label" || key === "name" || key === "display_name" || /\blabel\b|\bname\b/.test(fieldName)) return label;

  if (taxonomyValueId && (key.includes("taxonomy_reference") || /taxonomy.*reference/.test(typeName))) {
    if (typeName.startsWith("list.") || key === "color_taxonomy_reference") return JSON.stringify([taxonomyValueId]);
    return taxonomyValueId;
  }

  if (key === "color" || /hex|rgb/.test(fieldName)) {
    const colorHex: Record<string, string> = {
      Black: "#000000",
      White: "#ffffff",
      Beige: "#d8c3a5",
      Blue: "#1d4ed8",
      Brown: "#7c4a28",
      Gold: "#d4af37",
      Green: "#16a34a",
      Gray: "#808080",
      Grey: "#808080",
      Navy: "#001f3f",
      Orange: "#f97316",
      Pink: "#ec4899",
      Purple: "#7e22ce",
      Red: "#dc2626",
      Silver: "#c0c0c0",
      Yellow: "#facc15",
    };
    return colorHex[label] || "#808080";
  }

  if (/single_line_text_field|multi_line_text_field/.test(typeName)) return label;
  if (field.required) {
    // Last safe fallback for required non-reference fields.
    return label;
  }

  return "";
}

async function createCategoryMetaobject(
  admin: AdminClient,
  target: CategoryMetafieldTarget,
  metaobjectType: string,
  label: string,
  taxonomyValueId: string,
) {
  const definition = await ensureStandardMetaobjectDefinition(admin, metaobjectType);
  if (!definition?.id) return "";

  const fields: Array<{ key: string; value: string }> = [];
  const seenKeys = new Set<string>();

  for (const field of definition.fieldDefinitions || []) {
    const value = metaobjectFieldValueFor(definition, field, label, taxonomyValueId, target);
    if (!safeText(value)) continue;
    if (seenKeys.has(field.key)) continue;
    seenKeys.add(field.key);
    fields.push({ key: field.key, value });
  }

  if (fields.length === 0) {
    fields.push({ key: safeText(definition.displayNameKey) || "label", value: label });
    if (taxonomyValueId) fields.push({ key: "taxonomy_reference", value: taxonomyValueId });
  }

  const handle = `${target.key}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

  try {
    const data = await shopifyGraphql<{
      metaobjectCreate: {
        metaobject?: { id: string; displayName?: string | null } | null;
        userErrors?: Array<{ field?: string[] | null; message: string; code?: string }>;
      };
    }>(
      admin,
      `#graphql
      mutation ParserVoCreateCategoryMetaobject($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
            displayName
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      {
        metaobject: {
          type: metaobjectType,
          handle,
          fields,
        },
      },
    );

    if (data.metaobjectCreate.metaobject?.id) return data.metaobjectCreate.metaobject.id;

    const alreadyExists = (data.metaobjectCreate.userErrors || []).some((error) => /taken|exists|already/i.test(error.message));
    if (alreadyExists) {
      return findExistingMetaobjectByLabel(admin, metaobjectType, label);
    }

    return "";
  } catch {
    return findExistingMetaobjectByLabel(admin, metaobjectType, label);
  }
}

async function ensureCategoryMetaobjectReference(
  admin: AdminClient,
  target: CategoryMetafieldTarget,
  label: string,
  taxonomyLookup: TaxonomyAttributeLookup,
) {
  for (const metaobjectType of target.metaobjectTypes) {
    const existing = await findExistingMetaobjectByLabel(admin, metaobjectType, label);
    if (existing) return existing;

    const taxonomyValueId = findTaxonomyValueId(taxonomyLookup, target, label);
    const created = await createCategoryMetaobject(admin, target, metaobjectType, label, taxonomyValueId);
    if (created) return created;
  }

  return "";
}

type PreparedCategoryMetafieldReference = {
  key: string;
  displayName: string;
  labels: string[];
  referenceIds: string[];
  referenceByLabel: Record<string, string>;
  errors: string[];
};

async function prepareNativeCategoryMetafieldReferences(
  admin: AdminClient,
  product: Parameters<typeof buildNativeCategoryMetafieldTargets>[0],
  variants: Array<{ size?: string | null; supplierSizeLabel?: string | null; available?: boolean | null }>,
  taxonomyCategoryId: string | null | undefined,
): Promise<PreparedCategoryMetafieldReference[]> {
  const targets = buildNativeCategoryMetafieldTargets(product, variants);
  if (targets.length === 0) return [];

  const taxonomyLookup = await getTaxonomyAttributeLookup(admin, taxonomyCategoryId);
  const prepared: PreparedCategoryMetafieldReference[] = [];

  for (const target of targets) {
    const item: PreparedCategoryMetafieldReference = {
      key: target.key,
      displayName: target.displayName,
      labels: target.labels,
      referenceIds: [],
      referenceByLabel: {},
      errors: [],
    };

    const definition = await ensureStandardProductMetafieldDefinition(admin, target.key);
    if (!definition.ok) {
      item.errors.push(`standard product metafield definition shopify.${target.key} was not enabled: ${definition.message}`);
    }

    for (const label of target.labels) {
      let referenceId = "";
      const candidates = taxonomyLabelCandidates(target, label);
      const candidateLabels = Array.from(new Set([label, ...candidates])).filter(Boolean);

      for (const candidateLabel of candidateLabels) {
        referenceId = await ensureCategoryMetaobjectReference(admin, target, candidateLabel, taxonomyLookup);
        if (referenceId) {
          item.referenceByLabel[label] = referenceId;
          item.referenceByLabel[candidateLabel] = referenceId;
          for (const alias of taxonomyLabelCandidates(target, candidateLabel)) {
            item.referenceByLabel[alias] = referenceId;
          }
          break;
        }
      }

      if (referenceId) {
        item.referenceIds.push(referenceId);
      } else {
        item.errors.push(`cannot create/find metaobject for ${label} (${target.metaobjectTypes.join(" / ")})`);
      }
    }

    item.referenceIds = Array.from(new Set(item.referenceIds));
    prepared.push(item);
  }

  return prepared;
}

async function setNativeCategoryMetafieldsBestEffort(
  admin: AdminClient,
  productGid: string,
  product: Parameters<typeof buildNativeCategoryMetafieldTargets>[0],
  variants: Array<{ size?: string | null; supplierSizeLabel?: string | null; available?: boolean | null }>,
  taxonomyCategoryId: string | null | undefined,
  preparedReferences?: PreparedCategoryMetafieldReference[],
): Promise<CategoryMetafieldSyncResult> {
  const result: CategoryMetafieldSyncResult = { attempted: 0, synced: 0, skipped: 0, errors: [] };
  const prepared = preparedReferences || await prepareNativeCategoryMetafieldReferences(admin, product, variants, taxonomyCategoryId);
  if (prepared.length === 0) return result;

  const metafields: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }> = [];

  for (const target of prepared) {
    result.attempted += 1;
    if (target.errors.length) {
      result.errors.push(...target.errors.map((error) => `${target.displayName}: ${error}`));
    }

    if (target.referenceIds.length === 0) {
      result.skipped += 1;
      continue;
    }

    metafields.push({
      ownerId: productGid,
      namespace: "shopify",
      key: target.key,
      type: "list.metaobject_reference",
      value: JSON.stringify(Array.from(new Set(target.referenceIds))),
    });
  }

  if (metafields.length === 0) return result;

  try {
    const data = await shopifyGraphql<{
      metafieldsSet: {
        metafields?: Array<{ id: string; namespace: string; key: string; value: string }>;
        userErrors?: Array<{ field?: string[] | null; message: string; code?: string; elementIndex?: number | null }>;
      };
    }>(
      admin,
      `#graphql
      mutation ParserVoSetNativeCategoryMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
            code
            elementIndex
          }
        }
      }`,
      { metafields },
    );

    const userErrors = data.metafieldsSet.userErrors || [];
    if (userErrors.length > 0) {
      result.errors.push(...userErrors.map((error) => `category metafield ${error.elementIndex ?? ""}: ${error.message}`));
    }

    result.synced = data.metafieldsSet.metafields?.length || 0;
    result.skipped += Math.max(0, metafields.length - result.synced);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.skipped += metafields.length;
  }

  return result;
}

async function syncCategoryMetafieldsForImportedProductInternal(
  admin: AdminClient,
  importedProductId: string,
  shop: string,
) {
  const product = await db.importedProduct.findFirst({
    where: { id: importedProductId, shop },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });

  if (!product) throw new ShopifyProductSyncError("Imported product not found.");
  if (!product.shopifyProductGid) {
    throw new ShopifyProductSyncError("Товар еще не создан в Shopify. Сначала создай товар, потом синхронизируй Category metafields.");
  }

  const availableVariants = product.variants.filter((variant: any) => variant.available);
  const variants = sortVariantsForShopify(
    product.variants.length > 0
      ? availableVariants
      : [{ id: "default", size: "Default Title", supplierSizeLabel: "Default Title", available: true }],
  );
  const taxonomyCategory = await resolveShopifyTaxonomyCategory(admin, product);
  const result = await setNativeCategoryMetafieldsBestEffort(admin, product.shopifyProductGid, product, variants, taxonomyCategory.id || null);

  await db.syncLog.create({
    data: {
      shop,
      importedProductId: product.id,
      supplierName: product.supplierName,
      supplierUrl: product.supplierUrl,
      status: result.synced > 0 ? "category_metafields_synced" : "category_metafields_warning",
      message: `Category metafields sync. Attempted: ${result.attempted}. Synced: ${result.synced}. Skipped: ${result.skipped}.${result.errors.length ? ` Errors: ${result.errors.slice(0, 8).join(" | ")}` : ""}`,
      newAvailableSizes: product.variants.filter((variant: any) => variant.available).map((variant: any) => variant.size).join(", "),
    },
  });

  return result;
}

export async function syncCategoryMetafieldsForImportedProduct(
  admin: AdminClient,
  importedProductId: string,
  shop: string,
) {
  return syncCategoryMetafieldsForImportedProductInternal(admin, importedProductId, shop);
}

export async function syncCategoryMetafieldsForImportedProducts(
  admin: AdminClient,
  shop: string,
  productIds: string[],
) {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  const result = { total: ids.length, synced: 0, failed: 0, errors: [] as string[] };

  for (const productId of ids) {
    try {
      const syncResult = await syncCategoryMetafieldsForImportedProductInternal(admin, productId, shop);
      if (syncResult.synced > 0) result.synced += 1;
      else {
        result.failed += 1;
        result.errors.push(`${productId}: ${syncResult.errors.join(" | ") || "no category metafields synced"}`);
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push(`${productId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

export async function createShopifyProductFromImported(
  admin: AdminClient,
  importedProductId: string,
  shop: string,
  options: {
    status?: ProductStatus;
    locationId?: string | null;
  } = {},
) {
  const product = await db.importedProduct.findFirst({
    where: { id: importedProductId, shop },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });

  if (!product) {
    throw new ShopifyProductSyncError("Imported product not found.");
  }

  if (product.shopifyProductGid) {
    return {
      ok: true,
      skipped: true,
      productGid: product.shopifyProductGid,
      productTitle: product.shopifyProductTitle || product.title,
      message: "Product already exists in Shopify.",
    };
  }

  const resolvedLocation = await tryResolveShopifyLocationId(admin, options.locationId);
  const locationId = resolvedLocation?.locationId || null;
  const status = options.status || "DRAFT";
  const shopifyTitle = buildProductTitle(product);
  const images = parseImages(product.imagesJson, product.imageUrl);
  const availableImportedVariants = product.variants.filter((variant: any) => variant.available);
  if (product.variants.length > 0 && availableImportedVariants.length === 0) {
    throw new ShopifyProductSyncError("Товар не создан в Shopify: у поставщика нет доступных размеров.");
  }

  const productVariants: ImportedVariantForShopify[] = sortVariantsForShopify(
    product.variants.length > 0
      ? availableImportedVariants
      : [
          {
            id: "default",
            size: "Default Title",
            supplierSizeLabel: "Default Title",
            available: true,
            sku: product.supplierSymbol || product.supplierProductId,
            price: product.salePriceUah || 0,
            compareAtPrice: product.compareAtPriceUah || 0,
          },
        ],
  );

  const sizeMap = buildSizeMap(productVariants);
  const imageFiles = images.map((imageUrl, index) => ({
    originalSource: imageUrl,
    alt: `${shopifyTitle} ${index + 1}`,
    filename: `${slugifyFilename(`${product.brand || "product"}-${product.supplierProductId}-${index + 1}`)}.${imageUrl.split(".").pop()?.split("?")[0] || "jpg"}`,
    contentType: "IMAGE",
  }));
  const supplierHandle = supplierHandleFromUrl(product.supplierUrl) || sanitizeHandle(shopifyTitle);
  const seo = {
    title: buildSeoTitle(product),
    description: buildSeoDescription(product),
  };
  const detectedCategoryPath = detectShopifyCategoryPath(product);
  const taxonomyCategory = await resolveShopifyTaxonomyCategory(admin, product);
  const preparedCategoryMetafields = await prepareNativeCategoryMetafieldReferences(
    admin,
    product,
    productVariants,
    taxonomyCategory.id || null,
  );
  const preparedSizeMetafield = preparedCategoryMetafields.find((item) => item.key === "size");
  const sizeReferenceIdForOption = (size: string | null | undefined) => {
    if (!preparedSizeMetafield) return "";
    const candidates = uniqueLabels([
      safeText(size),
      normalizeSizeLabel(size),
      shopifySizeLabel(size),
      ...taxonomyLabelCandidates(
        { key: "size", displayName: "Size", attributeNames: [], metaobjectTypes: [], labels: [] },
        safeText(size),
      ),
      ...taxonomyLabelCandidates(
        { key: "size", displayName: "Size", attributeNames: [], metaobjectTypes: [], labels: [] },
        shopifySizeLabel(size),
      ),
    ]);

    for (const candidate of candidates) {
      const found = preparedSizeMetafield.referenceByLabel[candidate];
      if (found) return found;
    }

    return "";
  };
  const canUseLinkedSizeOption = sizeMap.length > 0 && sizeMap.every((item) => Boolean(sizeReferenceIdForOption(item.size)));
  const sizeValues = sizeMap.map((item) => {
    const linkedMetafieldValue = sizeReferenceIdForOption(item.size);
    return canUseLinkedSizeOption && linkedMetafieldValue
      ? { linkedMetafieldValue }
      : { name: item.size };
  });

  const input = {
    title: shopifyTitle,
    handle: supplierHandle,
    redirectNewHandle: false,
    descriptionHtml: buildDescriptionHtml(product),
    seo,
    vendor: product.brand || product.supplierName,
    productType: product.categoryUa || product.productType || product.category || "",
    status,
    tags: buildTags(product),
    ...(taxonomyCategory.id ? { category: taxonomyCategory.id } : {}),
    productOptions: [
      {
        name: "Size",
        position: 1,
        ...(canUseLinkedSizeOption
          ? {
              linkedMetafield: {
                namespace: "shopify",
                key: "size",
              },
            }
          : {}),
        values: sizeValues,
      },
    ],
    files: imageFiles,
    metafields: uniqueProductMetafields([
      {
        namespace: "parservo",
        key: "supplier_name",
        type: "single_line_text_field",
        value: product.supplierName,
      },
      {
        namespace: "parservo",
        key: "supplier_product_id",
        type: "single_line_text_field",
        value: product.supplierProductId,
      },
      {
        namespace: "parservo",
        key: "supplier_url",
        type: "url",
        value: product.supplierUrl,
      },
      {
        namespace: "parservo",
        key: "shopify_category_path",
        type: "single_line_text_field",
        value: taxonomyCategory.matchedFullName || detectedCategoryPath,
      },
      {
        namespace: "custom",
        key: "delivery_from",
        type: "single_line_text_field",
        value: "Доставка з Європи",
      },
      {
        namespace: "custom",
        key: "filter_name",
        type: "single_line_text_field",
        value: product.categoryUa || product.productType || product.category || "",
      },
      {
        namespace: "custom",
        key: "name_type",
        type: "single_line_text_field",
        value: product.categoryUa || product.productType || product.category || "",
      },
      {
        namespace: "custom",
        key: "color",
        type: "single_line_text_field",
        value: product.colorUa || product.color || "",
      },
      {
        namespace: "custom",
        key: "target_gender",
        type: "single_line_text_field",
        value: product.genderUa || product.gender || "",
      },
      ...buildCustomCategoryAttributeMetafields(product, productVariants),
    ]),
    variants: productVariants.map((variant: ImportedVariantForShopify, index: number) => {
      const variantSku = safeText(variant.sku) || `${product.supplierSymbol || product.supplierProductId}-${safeText(variant.size) || index + 1}`;

      return {
        optionValues: [
          (() => {
            const sizeValue = sizeMap[index]?.size || safeText(variant.size) || `Size ${index + 1}`;
            const linkedMetafieldValue = sizeReferenceIdForOption(sizeValue);
            return canUseLinkedSizeOption && linkedMetafieldValue
              ? { optionName: "Size", linkedMetafieldValue }
              : { optionName: "Size", name: sizeValue };
          })(),
        ],
        sku: variantSku,
        price: toMoney(variant.price || product.salePriceUah),
        compareAtPrice: product.compareAtPriceUah && product.compareAtPriceUah > 0 ? toMoney(variant.compareAtPrice || product.compareAtPriceUah) : null,
        inventoryPolicy: "DENY",
        taxable: true,
        ...(locationId
          ? {
              inventoryItem: {
                tracked: true,
                requiresShipping: true,
                cost: product.costPriceUah && product.costPriceUah > 0 ? toMoney(product.costPriceUah) : undefined,
              },
              inventoryQuantities: [
                {
                  locationId,
                  name: "available",
                  quantity: variant.available ? 1 : 0,
                },
              ],
            }
          : {}),
        metafields: [
          {
            namespace: "parservo",
            key: "supplier_size",
            type: "single_line_text_field",
            value: safeText(variant.supplierSizeLabel) || safeText(variant.size) || "Default Title",
          },
        ],
      };
    }),
  };

  const data = await shopifyGraphql<{
    productSet: {
      product: {
        id: string;
        title: string;
        handle?: string | null;
        status?: string | null;
        variants: { nodes: ShopifyVariantNode[] };
      } | null;
      userErrors: ShopifyGraphqlUserError[];
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoCreateShopifyProduct($productSet: ProductSetInput!, $synchronous: Boolean!) {
      productSet(synchronous: $synchronous, input: $productSet) {
        product {
          id
          title
          handle
          status
          variants(first: 250) {
            nodes {
              id
              title
              sku
              selectedOptions {
                name
                value
              }
            }
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    { productSet: input, synchronous: true },
  );

  throwUserErrors("Shopify product create failed", data.productSet.userErrors);

  const shopifyProduct = data.productSet.product;
  if (!shopifyProduct?.id) {
    throw new ShopifyProductSyncError("Shopify did not return created product ID.", data);
  }

  const categoryMetafieldResult = await setNativeCategoryMetafieldsBestEffort(
    admin,
    shopifyProduct.id,
    product,
    productVariants,
    taxonomyCategory.id || null,
    preparedCategoryMetafields,
  );

  const variantsWithInventory = await tryFetchProductVariantsWithInventory(admin, shopifyProduct.id);
  const returnedVariants = variantsWithInventory.length > 0 ? variantsWithInventory : shopifyProduct.variants.nodes;

  await db.importedProduct.update({
    where: { id: product.id },
    data: {
      shopifyProductGid: shopifyProduct.id,
      shopifyProductId: legacyIdFromGid(shopifyProduct.id),
      shopifyProductTitle: shopifyProduct.title,
      status: status === "ACTIVE" ? "active" : "shopify_draft",
      lastSyncedAt: new Date(),
    },
  });

  for (const importedVariant of product.variants) {
    const matched = returnedVariants.find((node) => {
      const sizeOption = node.selectedOptions?.find((option) => option.name.toLowerCase() === "size");
      return sizeOption?.value === sizeMap.find((item) => item.importedVariantId === importedVariant.id)?.size;
    });

    if (!matched) continue;

    await db.importedVariant.update({
      where: { id: importedVariant.id },
      data: {
        shopifyVariantGid: matched.id,
        shopifyVariantId: legacyIdFromGid(matched.id),
        shopifyInventoryItemId: matched.inventoryItem?.id || "",
      },
    });
  }

  await db.syncLog.create({
    data: {
      shop,
      importedProductId: product.id,
      supplierName: product.supplierName,
      supplierUrl: product.supplierUrl,
      status: "shopify_product_created",
      message: `Created Shopify product as ${status}. Product: ${shopifyProduct.title}${locationId ? "" : " Initial inventory was skipped because Shopify Location access/ID is not available yet."} Category metafields synced: ${categoryMetafieldResult.synced}. ${categoryMetafieldResult.errors.length ? `Warnings: ${categoryMetafieldResult.errors.slice(0, 3).join(" | ")}` : ""}`,
      newAvailableSizes: product.variants.filter((variant: any) => variant.available).map((variant: any) => variant.size).join(", "),
    },
  });

  return {
    ok: true,
    skipped: false,
    productGid: shopifyProduct.id,
    productTitle: shopifyProduct.title,
    variants: returnedVariants,
  };
}

async function tryFetchProductVariantsWithInventory(admin: AdminClient, productGid: string): Promise<ShopifyVariantNode[]> {
  try {
    const data = await shopifyGraphql<{
      product: { variants: { nodes: ShopifyVariantNode[] } } | null;
    }>(
      admin,
      `#graphql
      query ParserVoProductVariantsWithInventory($id: ID!) {
        product(id: $id) {
          variants(first: 250) {
            nodes {
              id
              title
              sku
              selectedOptions {
                name
                value
              }
              inventoryItem {
                id
              }
            }
          }
        }
      }`,
      { id: productGid },
    );

    return data.product?.variants.nodes || [];
  } catch {
    return [];
  }
}

async function backfillInventoryItemIds(admin: AdminClient, product: {
  id: string;
  shopifyProductGid: string | null;
  variants: Array<{
    id: string;
    shopifyVariantGid: string | null;
    shopifyInventoryItemId: string | null;
  }>;
}) {
  if (!product.shopifyProductGid) return product.variants;

  const variantsWithInventory = await tryFetchProductVariantsWithInventory(admin, product.shopifyProductGid);
  if (variantsWithInventory.length === 0) return product.variants;

  for (const importedVariant of product.variants) {
    if (importedVariant.shopifyInventoryItemId) continue;

    const matched = variantsWithInventory.find((variant) => variant.id === importedVariant.shopifyVariantGid);
    if (!matched?.inventoryItem?.id) continue;

    await db.importedVariant.update({
      where: { id: importedVariant.id },
      data: { shopifyInventoryItemId: matched.inventoryItem.id },
    });

    importedVariant.shopifyInventoryItemId = matched.inventoryItem.id;
  }

  return product.variants;
}

export async function updateShopifyProductStatus(
  admin: AdminClient,
  productGid: string,
  status: ProductStatus,
) {
  const data = await shopifyGraphql<{
    productUpdate: {
      product: { id: string; status: string } | null;
      userErrors: ShopifyGraphqlUserError[];
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoUpdateProductStatus($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          status
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    { product: { id: productGid, status } },
  );

  throwUserErrors("Shopify product status update failed", data.productUpdate.userErrors);
  return data.productUpdate.product;
}

export async function syncShopifyInventoryForProduct(
  admin: AdminClient,
  importedProductId: string,
  shop: string,
  options: {
    locationId?: string | null;
    autoDraftSoldOut?: boolean;
    autoActivateAvailable?: boolean;
  } = {},
) {
  const product = await db.importedProduct.findFirst({
    where: { id: importedProductId, shop },
    include: { variants: true },
  });

  if (!product) {
    throw new ShopifyProductSyncError("Imported product not found for inventory sync.");
  }

  if (!product.shopifyProductGid) {
    return {
      ok: false,
      skipped: true,
      reason: "No Shopify product linked yet.",
    };
  }

  let variantsWithInventory = product.variants.filter((variant: any) => variant.shopifyInventoryItemId);

  if (variantsWithInventory.length === 0) {
    await backfillInventoryItemIds(admin, product);
    variantsWithInventory = product.variants.filter((variant: any) => variant.shopifyInventoryItemId);
  }

  if (variantsWithInventory.length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: "No Shopify inventory item IDs linked yet. Обнови scopes read_inventory/write_inventory и переустанови приложение, затем запусти Stock Sync еще раз.",
    };
  }

  const { locationId } = await resolveShopifyLocationId(admin, options.locationId);
  const quantities = variantsWithInventory.map((variant: any) => ({
    inventoryItemId: variant.shopifyInventoryItemId,
    locationId,
    quantity: variant.available ? 1 : 0,
  }));

  const data = await shopifyGraphql<{
    inventorySetQuantities: {
      inventoryAdjustmentGroup: { createdAt: string; reason?: string | null } | null;
      userErrors: ShopifyGraphqlUserError[];
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoInventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          createdAt
          reason
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );

  throwUserErrors("Shopify inventory update failed", data.inventorySetQuantities.userErrors);

  const availableSizes = product.variants.filter((variant: any) => variant.available).map((variant: any) => variant.size);
  const hasStock = availableSizes.length > 0;
  let newLocalStatus = product.status;

  if (!hasStock && options.autoDraftSoldOut) {
    await updateShopifyProductStatus(admin, product.shopifyProductGid, "DRAFT");
    newLocalStatus = "drafted_by_sync";
  }

  if (hasStock && options.autoActivateAvailable) {
    await updateShopifyProductStatus(admin, product.shopifyProductGid, "ACTIVE");
    newLocalStatus = "active";
  }

  await db.importedProduct.update({
    where: { id: product.id },
    data: {
      stockSourceStatus: hasStock ? "supplier_available" : "supplier_sold_out",
      status: newLocalStatus,
      lastSyncedAt: new Date(),
    },
  });

  await db.syncLog.create({
    data: {
      shop,
      importedProductId: product.id,
      supplierName: product.supplierName,
      supplierUrl: product.supplierUrl,
      status: "shopify_inventory_synced",
      message: `Shopify inventory synced. Available sizes: ${availableSizes.join(", ") || "none"}`,
      newAvailableSizes: availableSizes.join(", "),
    },
  });

  return {
    ok: true,
    syncedVariants: quantities.length,
    availableSizes,
  };
}

export async function createImportedProductsInShopify(
  admin: AdminClient,
  shop: string,
  options: {
    limit?: number | null;
    productIds?: string[];
    status?: ProductStatus;
    locationId?: string | null;
    allNotCreated?: boolean;
  } = {},
) {
  const cleanIds = uniqueStrings(options.productIds || []);
  const limit = options.allNotCreated
    ? undefined
    : Math.max(1, Math.min(500, Number(options.limit || cleanIds.length || 20)));

  const products = await db.importedProduct.findMany({
    where: {
      shop,
      shopifyProductGid: null,
      ...(cleanIds.length > 0 ? { id: { in: cleanIds } } : {}),
    },
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const product of products) {
    try {
      const result = await createShopifyProductFromImported(admin, product.id, shop, {
        status: options.status || "DRAFT",
        locationId: options.locationId,
      });

      if (result.skipped) skipped += 1;
      else created += 1;
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
          status: "shopify_product_create_error",
          message: "Failed to create Shopify product.",
          errorMessage: message,
        },
      });
    }
  }

  return {
    total: products.length,
    created,
    skipped,
    failed,
    errors,
  };
}

export async function createNextImportedProductsInShopify(
  admin: AdminClient,
  shop: string,
  options: {
    limit?: number;
    status?: ProductStatus;
    locationId?: string | null;
  } = {},
) {
  return createImportedProductsInShopify(admin, shop, {
    limit: options.limit || 20,
    status: options.status || "DRAFT",
    locationId: options.locationId,
  });
}

async function deleteShopifyProduct(admin: AdminClient, productGid: string) {
  const data = await shopifyGraphql<{
    productDelete: {
      deletedProductId?: string | null;
      userErrors: ShopifyGraphqlUserError[];
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoDeleteProduct($input: ProductDeleteInput!, $synchronous: Boolean!) {
      productDelete(input: $input, synchronous: $synchronous) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }`,
    { input: { id: productGid }, synchronous: true },
  );

  throwUserErrors("Shopify product delete failed", data.productDelete.userErrors);
  return data.productDelete.deletedProductId || productGid;
}

export async function deleteShopifyProductAndImported(
  admin: AdminClient,
  importedProductId: string,
  shop: string,
) {
  const product = await db.importedProduct.findFirst({ where: { id: importedProductId, shop } });
  if (!product) return { deletedFromShopify: false, deletedFromApp: false, title: "Unknown product" };

  let deletedFromShopify = false;
  if (product.shopifyProductGid) {
    await deleteShopifyProduct(admin, product.shopifyProductGid);
    deletedFromShopify = true;
  }

  await db.importedProduct.delete({ where: { id: product.id } });

  return {
    deletedFromShopify,
    deletedFromApp: true,
    title: product.originalTitle || product.title,
  };
}

export async function deleteImportedProductsAndShopify(
  admin: AdminClient,
  shop: string,
  productIds: string[],
) {
  const cleanIds = uniqueStrings(productIds);
  let deletedFromShopify = 0;
  let deletedFromApp = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const productId of cleanIds) {
    try {
      const result = await deleteShopifyProductAndImported(admin, productId, shop);
      if (result.deletedFromShopify) deletedFromShopify += 1;
      if (result.deletedFromApp) deletedFromApp += 1;
    } catch (error) {
      failed += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { total: cleanIds.length, deletedFromShopify, deletedFromApp, failed, errors };
}

export async function cleanupImportedProductsDeletedInShopify(admin: AdminClient, shop: string) {
  const linkedProducts: Array<{ id: string; shopifyProductGid: string | null }> = await db.importedProduct.findMany({
    where: {
      shop,
      shopifyProductGid: { not: null },
    },
    select: { id: true, shopifyProductGid: true },
  });

  const ids = linkedProducts.map((product: { shopifyProductGid: string | null }) => product.shopifyProductGid).filter(Boolean) as string[];
  if (ids.length === 0) return { removed: 0 };

  let removed = 0;

  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    try {
      const data = await shopifyGraphql<{
        nodes: Array<{ id: string } | null>;
      }>(
        admin,
        `#graphql
        query ParserVoCheckLinkedProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            id
          }
        }`,
        { ids: chunk },
      );

      const existingIds = new Set((data.nodes || []).filter(Boolean).map((node) => node!.id));
      const missingLocalIds = linkedProducts
        .filter((product: { id: string; shopifyProductGid: string | null }) => product.shopifyProductGid && chunk.includes(product.shopifyProductGid) && !existingIds.has(product.shopifyProductGid))
        .map((product: { id: string }) => product.id);

      if (missingLocalIds.length > 0) {
        const result = await db.importedProduct.deleteMany({ where: { id: { in: missingLocalIds }, shop } });
        removed += result.count;
      }
    } catch {
      // Не блокируем загрузку страницы, если Shopify временно не дал проверить nodes.
    }
  }

  return { removed };
}

export async function syncLinkedProductsInventory(
  admin: AdminClient,
  shop: string,
  options: {
    limit?: number;
    locationId?: string | null;
    autoDraftSoldOut?: boolean;
    autoActivateAvailable?: boolean;
  } = {},
) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
  const products = await db.importedProduct.findMany({
    where: {
      shop,
      shopifyProductGid: { not: null },
      syncEnabled: true,
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const product of products) {
    try {
      const result = await syncShopifyInventoryForProduct(admin, product.id, shop, options);
      if (result.skipped) skipped += 1;
      else synced += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${product.title}: ${message}`);

      await db.syncLog.create({
        data: {
          shop,
          importedProductId: product.id,
          supplierName: product.supplierName,
          supplierUrl: product.supplierUrl,
          status: "shopify_inventory_sync_error",
          message: "Failed to sync Shopify inventory.",
          errorMessage: message,
        },
      });
    }
  }

  return {
    total: products.length,
    synced,
    skipped,
    failed,
    errors,
  };
}
