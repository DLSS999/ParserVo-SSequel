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

function normalizeSkuForMatch(value: string | null | undefined) {
  return safeText(value)
    .toUpperCase()
    .replace(/[\s_]+/g, "")
    .replace(/[^A-Z0-9.-]/g, "");
}

function normalizeVariantOptionForMatch(value: string | null | undefined) {
  return safeText(value).replace(",", ".").toUpperCase();
}

function isAlreadyActivatedInventoryMessage(value: string) {
  return /already active|already activated|already stocked|already exists|already connected/i.test(value);
}

function isInventoryNotStockedAtLocationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /not stocked at the location|inventory item.*not stocked|must be stocked|not active at location|not connected to this location/i.test(message);
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

function isDefaultNoSizeVariant(variant: { size?: string | null; supplierSizeLabel?: string | null } | null | undefined) {
  const size = normalizeSizeLabel(variant?.size);
  const supplierSize = normalizeSizeLabel(variant?.supplierSizeLabel);
  return size === "DEFAULT TITLE" || supplierSize === "DEFAULT TITLE" || supplierSize === "UNI" || supplierSize === "ONE SIZE" || supplierSize === "ONESIZE" || supplierSize === "OS";
}

function hasOnlyDefaultNoSizeVariant(variants: Array<{ size?: string | null; supplierSizeLabel?: string | null }>) {
  return variants.length === 1 && isDefaultNoSizeVariant(variants[0]);
}

function visibleSizeLabels(variants: Array<{ size?: string | null; supplierSizeLabel?: string | null; available?: boolean | null }>) {
  return variants
    .filter((variant) => variant.available)
    .filter((variant) => !isDefaultNoSizeVariant(variant))
    .map((variant) => safeText(variant.size) || safeText(variant.supplierSizeLabel))
    .filter(Boolean);
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
    .replace(/\b(sneakers?|shoes?|trainers?|boots?|sandals?|slides?|pumps?|loafers?|t[-\s]?shirts?|tees?|shirts?|polo|hoodies?|sweatshirts?|sweaters?|jackets?|coats?|dresses?|bags?|skirts?|trousers?|pants|jeans|shorts)\b/gi, " ")
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
  modelCode?: string | null;
  supplierSymbol?: string | null;
  supplierProductId?: string | null;
}) {
  const brand = safeText(product.brand);
  const model = buildProductVariantName(product);
  const nameType = seoNameType(buildNameTypeUa(product));
  const sku = buildSkuText(product);
  return `${brand}${model ? ` ${model}` : ""} ${nameType}${sku ? ` ${sku}` : ""} — купити в Україні | CINQ`
    .replace(/\s+/g, " ")
    .trim();
}

function buildSeoDescription(product: {
  brand?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  category?: string | null;
  modelCode?: string | null;
  supplierSymbol?: string | null;
  supplierProductId?: string | null;
}) {
  const brand = safeText(product.brand);
  const model = buildProductVariantName(product);
  const nameType = seoNameType(buildNameTypeUa(product));
  const sku = buildSkuText(product);
  return `Оригінальний ${brand}${model ? ` ${model}` : ""} ${nameType}${sku ? ` ${sku}` : ""} у CINQ. Актуальна наявність, допомога з розміром і доставка по Україні та з Європи й США.`
    .replace(/\s+/g, " ")
    .trim();
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
  return ["full_payment", "Vitkac", "PreOrder"];
}

function mappingSource(product: {
  title?: string | null;
  originalTitle?: string | null;
  category?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  breadcrumbs?: string | null;
  supplierUrl?: string | null;
}) {
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

function detectKind(product: Parameters<typeof mappingSource>[0]) {
  // Product title has the highest priority. Existing imported rows can contain
  // stale/wrong category values (for example category = "T-shirt" while title says "Sweatshirt").
  // We must not let those old category values override the actual product name.
  const titleText = ` ${[product.originalTitle, product.title].filter(Boolean).join(" ")} `.toLowerCase();
  const text = mappingSource(product);

  const detectFromText = (source: string) => {
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

    // These must be before T-shirt and Shirt so stale category values do not win.
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

  return detectFromText(titleText) || detectFromText(text);
}

function buildFilterNameUa(product: Parameters<typeof mappingSource>[0]) {
  const kind = detectKind(product);
  const map: Record<string, string> = {
    ankle_boots: "Ботильйони",
    sneakers: "Кросівки",
    loafers: "Лофери",
    moccasins: "Мокасини",
    mules: "Мюлі",
    clogs: "Сабо",
    sandals: "Сандалі",
    slides: "Шльопанці",
    boots: "Черевики",
    shoes: "Туфлі",
    backpack: "Рюкзаки",
    shopper: "Шопери",
    shoulder_bag: "Сумки",
    bag: "Сумки",
    belt: "Ремені",
    scarf: "Шарфи",
    socks: "Шкарпетки",
    cap: "Головні убори",
    hat: "Головні убори",
    swim_shorts: "Плавки",
    shorts: "Шорти",
    jeans: "Брюки та джинси",
    trousers: "Брюки та джинси",
    down_jacket: "Верхній одяг",
    jacket: "Верхній одяг",
    coat: "Верхній одяг",
    cardigan: "Светри та кардигани",
    turtleneck: "Светри та кардигани",
    zip_hoodie: "Худі та світшоти",
    hoodie: "Худі та світшоти",
    sweatshirt: "Худі та світшоти",
    sweater: "Светри та кардигани",
    longsleeve: "Футболки та поло",
    polo: "Футболки та поло",
    tshirt: "Футболки та поло",
    shirt: "Сорочки",
    bodysuit: "Топи",
    top: "Топи",
  };

  return map[kind] || "";
}

function buildNameTypeUa(product: Parameters<typeof mappingSource>[0]) {
  const kind = detectKind(product);
  const map: Record<string, string> = {
    ankle_boots: "Ботильйони",
    sneakers: "Кросівки",
    loafers: "Лофери",
    moccasins: "Мокасини",
    mules: "Мюлі",
    clogs: "Сабо",
    sandals: "Сандалі",
    slides: "Шльопанці",
    boots: "Черевики",
    shoes: "Туфлі",
    backpack: "Рюкзак",
    shopper: "Шопер",
    shoulder_bag: "Сумка на плече",
    bag: "Сумка",
    belt: "Ремінь",
    scarf: "Шарф",
    socks: "Шкарпетки",
    cap: "Кепка",
    hat: "Шапка",
    swim_shorts: "Шорти для плавання",
    shorts: "Шорти",
    jeans: "Джинси",
    trousers: "Брюки",
    down_jacket: "Пуховик",
    jacket: "Куртка",
    coat: "Пальто",
    cardigan: "Кардиган",
    turtleneck: "Водолазка",
    zip_hoodie: "Зіп-Худі",
    hoodie: "Худі",
    sweatshirt: "Світшот",
    sweater: "Светр",
    longsleeve: "Лонгслів",
    polo: "Поло",
    tshirt: "Футболка",
    shirt: "Сорочка",
    bodysuit: "Боді",
    top: "Топ",
  };

  return map[kind] || "";
}

function buildShopifyProductType(product: Parameters<typeof mappingSource>[0]) {
  const kind = detectKind(product);
  const map: Record<string, string> = {
    ankle_boots: "Ботильйони",
    sneakers: "Кросівки",
    loafers: "Лофери",
    moccasins: "Мокасини",
    mules: "Мюлі",
    clogs: "Сабо",
    sandals: "Сандалі",
    slides: "Шльопанці",
    boots: "Черевики",
    shoes: "Туфлі",
    backpack: "Рюкзаки",
    shopper: "Шопери",
    shoulder_bag: "Сумки на плече",
    bag: "Сумки",
    belt: "Ремені",
    scarf: "Шарфи",
    socks: "Шкарпетки",
    cap: "Кепки",
    hat: "Шапки",
    swim_shorts: "Шорти для плавання",
    shorts: "Шорти",
    jeans: "Джинси",
    trousers: "Брюки",
    down_jacket: "Пуховики",
    jacket: "Куртки",
    coat: "Пальта",
    cardigan: "Кардигани",
    turtleneck: "Водолазки",
    zip_hoodie: "Зіп-Худі",
    hoodie: "Худі",
    sweatshirt: "Світшоти",
    sweater: "Светри",
    longsleeve: "Футболки",
    polo: "Поло",
    tshirt: "Футболки",
    shirt: "Сорочки",
    bodysuit: "Боді",
    top: "Топи",
  };

  return map[kind] || safeText(product.categoryUa || product.productType || product.category || "");
}

function buildProductVariantName(product: {
  brand?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  categoryUa?: string | null;
}) {
  const title = safeText(product.originalTitle || product.title);
  const quoted = title.match(/[`“”"']([^`“”"']{2,80})[`“”"']/)?.[1];
  if (quoted) return quoted.trim();

  const model = buildModelName(product)
    .replace(/\b(with|logo|embroidered|printed|patch|regular fit|boxy fit|short sleeve|long sleeve)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return model.length >= 2 && model.length <= 60 ? model : "";
}

function buildColorVariantValue(product: { color?: string | null; colorUa?: string | null }) {
  return colorLabelForShopify(product.color || product.colorUa);
}

function buildColorValueUa(product: { color?: string | null; colorUa?: string | null }) {
  const explicitUa = safeText(product.colorUa);
  if (explicitUa) return explicitUa;

  const label = colorLabelForShopify(product.color);
  const map: Record<string, string> = {
    Beige: "Бежевий",
    Black: "Чорний",
    Blue: "Блакитний",
    Bronze: "Бронзовий",
    Brown: "Коричневий",
    Gold: "Золотий",
    Gray: "Сірий",
    Grey: "Сірий",
    Green: "Зелений",
    Navy: "Темно-синій",
    Orange: "Помаранчевий",
    Pink: "Рожевий",
    Purple: "Фіолетовий",
    Red: "Червоний",
    "Rose gold": "Рожеве золото",
    Silver: "Сріблястий",
    White: "Білий",
    Yellow: "Жовтий",
  };

  return map[label] || label;
}

function buildGenderValueUa(product: { gender?: string | null; genderUa?: string | null }) {
  const explicitUa = safeText(product.genderUa);
  if (/чолов/i.test(explicitUa)) return "Чоловічий";
  if (/жін|жіноч/i.test(explicitUa)) return "Жіночий";

  const normalized = safeText(product.gender).toLowerCase();
  if (/male|men/.test(normalized)) return "Чоловічий";
  if (/female|women/.test(normalized)) return "Жіночий";

  return "";
}

function buildSkuText(product: { modelCode?: string | null; supplierSymbol?: string | null; supplierProductId?: string | null }) {
  return safeText(product.modelCode || product.supplierSymbol || product.supplierProductId || "");
}

function seoNameType(value: string) {
  const clean = safeText(value);
  return clean ? clean.charAt(0).toLowerCase() + clean.slice(1) : "товар";
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

type StandardProductMetafieldDefinitionResult = {
  ok: boolean;
  alreadyEnabled: boolean;
  message: string;
  typeName: string;
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
  const normalized = safeText(value).toUpperCase().replace(/[\s_/-]+/g, " ").trim();
  const map: Record<string, string> = {
    BEIGE: "Beige",
    CREAM: "Beige",
    IVORY: "Beige",
    ECRU: "Beige",
    BLACK: "Black",
    BLUE: "Blue",
    BRONZE: "Bronze",
    BROWN: "Brown",
    GOLD: "Gold",
    GRAY: "Gray",
    GREY: "Grey",
    GREEN: "Green",
    NAVY: "Navy",
    "NAVY BLUE": "Navy",
    ORANGE: "Orange",
    PINK: "Pink",
    PURPLE: "Purple",
    RED: "Red",
    "ROSE GOLD": "Rose gold",
    SILVER: "Silver",
    WHITE: "White",
    YELLOW: "Yellow",
    БЕЖЕВИЙ: "Beige",
    КРЕМОВИЙ: "Beige",
    ЧОРНИЙ: "Black",
    БЛАКИТНИЙ: "Blue",
    СИНІЙ: "Blue",
    БРОНЗОВИЙ: "Bronze",
    КОРИЧНЕВИЙ: "Brown",
    ЗОЛОТИЙ: "Gold",
    СІРИЙ: "Gray",
    ЗЕЛЕНИЙ: "Green",
    "ТЕМНО СИНІЙ": "Navy",
    ПОМАРАНЧЕВИЙ: "Orange",
    РОЖЕВИЙ: "Pink",
    ФІОЛЕТОВИЙ: "Purple",
    ЧЕРВОНИЙ: "Red",
    "РОЖЕВЕ ЗОЛОТО": "Rose gold",
    СРІБЛЯСТИЙ: "Silver",
    БІЛИЙ: "White",
    ЖОВТИЙ: "Yellow",
  };

  const label = map[normalized] || map[normalized.split(" ")[0]] || "";
  const allowed = new Set([
    "Beige", "Black", "Blue", "Bronze", "Brown", "Gold", "Gray", "Green", "Grey", "Navy", "Orange", "Pink", "Purple", "Red", "Rose gold", "Silver", "White", "Yellow",
  ]);

  return allowed.has(label) ? label : "";
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
  if (/female|women|жін|жен/i.test(source)) return "Female";
  if (/male|men|чолов|муж/i.test(source)) return "Male";
  return "";
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
  // IMPORTANT: Shopify category metafields are not normal custom metafields.
  // For this store we intentionally sync ONLY the two native Shopify category fields
  // that are enabled and controlled in Admin:
  //   - shopify.color-pattern
  //   - shopify.target-gender
  // Do not sync size/fabric/age-group/care/features/neckline/sleeve/top-length here.
  // Those fields caused constrained-definition and owner-subtype errors in Shopify.
  void variants;

  const color = colorLabelForShopify(product.color || product.colorUa);
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
      key: "target-gender",
      displayName: "Target gender",
      attributeNames: ["Target gender", "Gender"],
      metaobjectTypes: ["shopify--target-gender"],
      labels: uniqueLabels([targetGender]),
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

async function ensureStandardProductMetafieldDefinition(admin: AdminClient, key: string): Promise<StandardProductMetafieldDefinitionResult> {
  const namespace = "shopify";
  const defaultTypeName = "list.metaobject_reference";

  try {
    const existing = await shopifyGraphql<{
      metafieldDefinition?: {
        id: string;
        namespace: string;
        key: string;
        type?: { name?: string | null; category?: string | null } | null;
      } | null;
    }>(
      admin,
      `#graphql
      query ParserVoProductMetafieldDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
        metafieldDefinition(identifier: $identifier) {
          id
          namespace
          key
          type {
            name
            category
          }
        }
      }`,
      { identifier: { ownerType: "PRODUCT", namespace, key } },
    );

    if (existing.metafieldDefinition?.id) {
      return {
        ok: true,
        alreadyEnabled: true,
        message: "enabled",
        typeName: safeText(existing.metafieldDefinition.type?.name) || defaultTypeName,
      };
    }
  } catch {
    // Continue to standardMetafieldDefinitionEnable.
  }

  try {
    const data = await shopifyGraphql<{
      standardMetafieldDefinitionEnable: {
        createdDefinition?: {
          id: string;
          namespace: string;
          key: string;
          type?: { name?: string | null; category?: string | null } | null;
        } | null;
        userErrors?: Array<{ field?: string[] | null; message: string; code?: string }>;
      };
    }>(
      admin,
      `#graphql
      mutation ParserVoEnableStandardProductMetafieldDefinition($namespace: String!, $key: String!) {
        standardMetafieldDefinitionEnable(
          ownerType: "PRODUCT",
          namespace: $namespace,
          key: $key,
          pin: false
        ) {
          createdDefinition {
            id
            namespace
            key
            type {
              name
              category
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { namespace, key },
    );

    const errors = data.standardMetafieldDefinitionEnable.userErrors || [];
    const created = data.standardMetafieldDefinitionEnable.createdDefinition;

    if (created?.id) {
      return {
        ok: true,
        alreadyEnabled: false,
        message: "created",
        typeName: safeText(created.type?.name) || defaultTypeName,
      };
    }

    if (errors.some((error) => /already|exist|taken|enabled/i.test(error.message))) {
      // Shopify can answer "already enabled" without returning the definition.
      // Re-read it so we use the real metafield type: metaobject_reference vs list.metaobject_reference.
      return ensureStandardProductMetafieldDefinition(admin, key);
    }

    return {
      ok: false,
      alreadyEnabled: false,
      message: errors.map((error) => error.message).join(" | ") || "unknown error",
      typeName: defaultTypeName,
    };
  } catch (error) {
    return {
      ok: false,
      alreadyEnabled: false,
      message: error instanceof Error ? error.message : String(error),
      typeName: defaultTypeName,
    };
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

    // Native Shopify category metafields are constrained. For color-pattern and
    // target-gender we must use Shopify's existing standard metaobjects only.
    // Creating our own metaobject can produce: "Owner subtype does not match the
    // metafield definition's constraints". Therefore we do not create missing
    // standard color/gender values; we simply skip if Shopify did not return one.
    if (target.key === "color-pattern" || target.key === "target-gender") {
      continue;
    }

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
  metafieldType: string;
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
    const definition = await ensureStandardProductMetafieldDefinition(admin, target.key);
    const item: PreparedCategoryMetafieldReference = {
      key: target.key,
      displayName: target.displayName,
      labels: target.labels,
      metafieldType: safeText(definition.typeName) || "list.metaobject_reference",
      referenceIds: [],
      referenceByLabel: {},
      errors: [],
    };

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
      } else if (target.key === "color-pattern" || target.key === "target-gender") {
        item.errors.push(`cannot find existing Shopify standard value for ${label} (${target.key})`);
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

    const referenceIds = Array.from(new Set(target.referenceIds));
    const metafieldType = safeText(target.metafieldType) || "list.metaobject_reference";
    const isListType = metafieldType.startsWith("list.");

    metafields.push({
      ownerId: productGid,
      namespace: "shopify",
      key: target.key,
      type: metafieldType,
      value: isListType ? JSON.stringify(referenceIds) : referenceIds[0],
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
      newAvailableSizes: visibleSizeLabels(product.variants).join(", "),
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
  const useDefaultVariantWithoutSizeOption = hasOnlyDefaultNoSizeVariant(productVariants);

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
  const sizeValues = sizeMap.map((item) => ({ name: item.size }));

  const input = {
    title: shopifyTitle,
    handle: supplierHandle,
    redirectNewHandle: false,
    descriptionHtml: buildDescriptionHtml(product),
    seo,
    vendor: product.brand || product.supplierName,
    productType: buildShopifyProductType(product),
    status,
    templateSuffix: "preorder",
    tags: buildTags(product),
    ...(taxonomyCategory.id ? { category: taxonomyCategory.id } : {}),
    productOptions: useDefaultVariantWithoutSizeOption
      ? [
          {
            name: "Title",
            position: 1,
            values: [{ name: "Default Title" }],
          },
        ]
      : [
          {
            name: "Size",
            position: 1,
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
        value: buildFilterNameUa(product),
      },
      {
        namespace: "custom",
        key: "name_type",
        type: "single_line_text_field",
        value: buildNameTypeUa(product),
      },
      {
        namespace: "custom",
        key: "product_variant",
        type: "single_line_text_field",
        value: buildProductVariantName(product),
      },
    ]),
    variants: productVariants.map((variant: ImportedVariantForShopify, index: number) => {
      const variantSku = safeText(variant.sku) || (useDefaultVariantWithoutSizeOption
        ? safeText(product.supplierSymbol) || safeText(product.supplierProductId)
        : `${product.supplierSymbol || product.supplierProductId}-${safeText(variant.size) || index + 1}`);

      return {
        optionValues: useDefaultVariantWithoutSizeOption
          ? [{ optionName: "Title", name: "Default Title" }]
          : [{ optionName: "Size", name: sizeMap[index]?.size || safeText(variant.size) || `Size ${index + 1}` }],
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
    const matched = useDefaultVariantWithoutSizeOption && isDefaultNoSizeVariant(importedVariant)
      ? returnedVariants[0]
      : returnedVariants.find((node) => {
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
      newAvailableSizes: visibleSizeLabels(product.variants).join(", "),
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
    size?: string | null;
    supplierSizeLabel?: string | null;
    sku?: string | null;
    shopifyVariantGid: string | null;
    shopifyInventoryItemId: string | null;
  }>;
}) {
  if (!product.shopifyProductGid) return product.variants;

  const variantsWithInventory = await tryFetchProductVariantsWithInventory(admin, product.shopifyProductGid);
  if (variantsWithInventory.length === 0) return product.variants;

  const unmatchedShopifyVariants = [...variantsWithInventory];

  for (const importedVariant of product.variants) {
    if (importedVariant.shopifyInventoryItemId) continue;

    const importedSku = normalizeSkuForMatch(importedVariant.sku);
    const importedSize = normalizeVariantOptionForMatch(importedVariant.size || importedVariant.supplierSizeLabel);

    const matched =
      unmatchedShopifyVariants.find((variant) => variant.id === importedVariant.shopifyVariantGid)
      || (importedSku
        ? unmatchedShopifyVariants.find((variant) => normalizeSkuForMatch(variant.sku) === importedSku)
        : null)
      || (importedSize
        ? unmatchedShopifyVariants.find((variant) => {
            const sizeOption = variant.selectedOptions?.find((option) => option.name.toLowerCase() === "size");
            return normalizeVariantOptionForMatch(sizeOption?.value || variant.title) === importedSize;
          })
        : null)
      || (product.variants.length === 1 && unmatchedShopifyVariants.length === 1 ? unmatchedShopifyVariants[0] : null);

    if (!matched?.inventoryItem?.id) continue;

    await db.importedVariant.update({
      where: { id: importedVariant.id },
      data: {
        shopifyVariantGid: matched.id,
        shopifyVariantId: legacyIdFromGid(matched.id),
        shopifyInventoryItemId: matched.inventoryItem.id,
      },
    });

    importedVariant.shopifyVariantGid = matched.id;
    importedVariant.shopifyInventoryItemId = matched.inventoryItem.id;

    const matchedIndex = unmatchedShopifyVariants.findIndex((variant) => variant.id === matched.id);
    if (matchedIndex >= 0) unmatchedShopifyVariants.splice(matchedIndex, 1);
  }

  return product.variants;
}

async function activateInventoryItemAtLocation(
  admin: AdminClient,
  inventoryItemId: string,
  locationId: string,
  available: number,
) {
  const data = await shopifyGraphql<{
    inventoryActivate: {
      inventoryLevel: { id: string } | null;
      userErrors: ShopifyGraphqlUserError[];
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoInventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
        inventoryLevel {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { inventoryItemId, locationId, available },
  );

  const errors = data.inventoryActivate.userErrors || [];
  const blockingErrors = errors.filter((error) => !isAlreadyActivatedInventoryMessage(error.message));
  throwUserErrors("Shopify inventory activation failed", blockingErrors);
  return data.inventoryActivate.inventoryLevel;
}

async function activateInventoryItemsAtLocation(
  admin: AdminClient,
  quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number }>,
) {
  for (const item of quantities) {
    await activateInventoryItemAtLocation(admin, item.inventoryItemId, item.locationId, item.quantity);
  }
}

async function setShopifyInventoryQuantities(
  admin: AdminClient,
  quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number }>,
) {
  const runSetQuantities = () => shopifyGraphql<{
    inventorySetQuantities: {
      inventoryAdjustmentGroup: { createdAt: string; reason?: string | null } | null;
      userErrors: ShopifyGraphqlUserError[];
    };
  }>(
    admin,
    `#graphql
    mutation ParserVoInventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          createdAt
          reason
        }
        userErrors {
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
    },
  );

  try {
    const data = await runSetQuantities();
    throwUserErrors("Shopify inventory update failed", data.inventorySetQuantities.userErrors);
    return data.inventorySetQuantities.inventoryAdjustmentGroup;
  } catch (error) {
    if (!isInventoryNotStockedAtLocationError(error)) throw error;

    await activateInventoryItemsAtLocation(admin, quantities);
    const data = await runSetQuantities();
    throwUserErrors("Shopify inventory update failed after inventory activation", data.inventorySetQuantities.userErrors);
    return data.inventorySetQuantities.inventoryAdjustmentGroup;
  }
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

  await setShopifyInventoryQuantities(admin, quantities);

  const availableSizes = visibleSizeLabels(product.variants);
  const hasStock = product.variants.some((variant: any) => variant.available);
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
          message: `Failed to sync Shopify inventory: ${message.slice(0, 450)}`,
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

type ShopifyInventoryQuantity = {
  name?: string | null;
  quantity?: number | null;
};

type ShopifyInventoryLevelNode = {
  location?: { id?: string | null; name?: string | null } | null;
  quantities?: ShopifyInventoryQuantity[] | null;
  available?: number | null;
};

type WarehouseTransferVariant = {
  id: string;
  title?: string | null;
  sku?: string | null;
  inventoryItem?: {
    id: string;
    inventoryLevels?: { nodes?: ShopifyInventoryLevelNode[] | null } | null;
  } | null;
};

type WarehouseTransferProductNode = {
  id: string;
  title: string;
  handle?: string | null;
  tags?: string[] | null;
  variants: { nodes: WarehouseTransferVariant[] };
};

function quoteShopifyTagSearchValue(tag: string) {
  const clean = safeText(tag).replace(/"/g, "\\\"");
  return `tag:"${clean}"`;
}

function inventoryAvailableAtLocation(variant: WarehouseTransferVariant, locationId: string) {
  const levels = variant.inventoryItem?.inventoryLevels?.nodes || [];
  const level = levels.find((item) => item.location?.id === locationId);
  if (!level) return 0;

  const availableQuantity = level.quantities?.find((quantity) => quantity.name === "available")?.quantity;
  if (Number.isFinite(Number(availableQuantity))) return Number(availableQuantity);
  if (Number.isFinite(Number(level.available))) return Number(level.available);
  return 0;
}

async function setInventoryPairBestEffort(
  admin: AdminClient,
  inventoryItemId: string,
  sourceLocationId: string,
  destinationLocationId: string,
  sourceAfter: number,
  destinationAfter: number,
) {
  await setShopifyInventoryQuantities(admin, [
    { inventoryItemId, locationId: sourceLocationId, quantity: sourceAfter },
    { inventoryItemId, locationId: destinationLocationId, quantity: destinationAfter },
  ]);
}

export async function getShopifyProductTags(admin: AdminClient, limit = 250) {
  try {
    const data = await shopifyGraphql<{
      productTags?: { nodes?: string[] | null; edges?: Array<{ node: string }> | null } | null;
    }>(
      admin,
      `#graphql
      query ParserVoProductTags($first: Int!) {
        productTags(first: $first) {
          nodes
        }
      }`,
      { first: Math.max(1, Math.min(250, Number(limit || 250))) },
    );

    const nodeTags = data.productTags?.nodes || [];
    const edgeTags = (data.productTags?.edges || []).map((edge) => edge.node);
    return uniqueStrings([...nodeTags, ...edgeTags]).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function transferInventoryByShopifyTagBatch(
  admin: AdminClient,
  options: {
    tag: string;
    sourceLocationId: string;
    destinationLocationId: string;
    cursor?: string | null;
    batchSize?: number | null;
    dryRun?: boolean;
    mode?: "add" | "replace";
  },
) {
  const tag = safeText(options.tag);
  const sourceLocationId = normalizeLocationGid(options.sourceLocationId);
  const destinationLocationId = normalizeLocationGid(options.destinationLocationId);
  const batchSize = Math.max(1, Math.min(25, Number(options.batchSize || 10)));
  const mode = options.mode === "replace" ? "replace" : "add";

  if (!tag) throw new ShopifyProductSyncError("Выбери тег Shopify для переноса остатков.");
  if (!sourceLocationId) throw new ShopifyProductSyncError("Выбери склад, С которого переносим остатки.");
  if (!destinationLocationId) throw new ShopifyProductSyncError("Выбери склад, НА который переносим остатки.");
  if (sourceLocationId === destinationLocationId) throw new ShopifyProductSyncError("Склад отправитель и склад получатель не могут быть одинаковыми.");

  const data = await shopifyGraphql<{
    products: {
      nodes: WarehouseTransferProductNode[];
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  }>(
    admin,
    `#graphql
    query ParserVoWarehouseTransferProducts($query: String!, $first: Int!, $after: String) {
      products(first: $first, after: $after, query: $query) {
        nodes {
          id
          title
          handle
          tags
          variants(first: 100) {
            nodes {
              id
              title
              sku
              inventoryItem {
                id
                inventoryLevels(first: 50) {
                  nodes {
                    location {
                      id
                      name
                    }
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`,
    {
      query: quoteShopifyTagSearchValue(tag),
      first: batchSize,
      after: options.cursor || null,
    },
  );

  const products = data.products.nodes || [];
  const errors: string[] = [];
  const productSummaries: Array<{
    title: string;
    movedUnits: number;
    updatedVariants: number;
    skippedVariants: number;
    errors: string[];
  }> = [];

  let processedProducts = 0;
  let movedProducts = 0;
  let updatedVariants = 0;
  let skippedVariants = 0;
  let failedVariants = 0;
  let movedUnits = 0;

  for (const product of products) {
    processedProducts += 1;
    let productMovedUnits = 0;
    let productUpdatedVariants = 0;
    let productSkippedVariants = 0;
    const productErrors: string[] = [];

    for (const variant of product.variants.nodes || []) {
      const inventoryItemId = variant.inventoryItem?.id;
      if (!inventoryItemId) {
        skippedVariants += 1;
        productSkippedVariants += 1;
        continue;
      }

      const sourceQuantity = inventoryAvailableAtLocation(variant, sourceLocationId);
      const destinationQuantity = inventoryAvailableAtLocation(variant, destinationLocationId);

      if (sourceQuantity <= 0) {
        skippedVariants += 1;
        productSkippedVariants += 1;
        continue;
      }

      const destinationAfter = mode === "replace" ? sourceQuantity : destinationQuantity + sourceQuantity;

      try {
        if (!options.dryRun) {
          await setInventoryPairBestEffort(admin, inventoryItemId, sourceLocationId, destinationLocationId, 0, destinationAfter);
        }
        updatedVariants += 1;
        productUpdatedVariants += 1;
        movedUnits += sourceQuantity;
        productMovedUnits += sourceQuantity;
      } catch (error) {
        failedVariants += 1;
        const message = error instanceof Error ? error.message : String(error || "Unknown inventory transfer error");
        const title = `${product.title}${variant.title ? ` / ${variant.title}` : ""}`;
        const fullMessage = `${title}: ${message}`.slice(0, 500);
        productErrors.push(fullMessage);
        errors.push(fullMessage);
      }
    }

    if (productMovedUnits > 0) movedProducts += 1;
    productSummaries.push({
      title: product.title,
      movedUnits: productMovedUnits,
      updatedVariants: productUpdatedVariants,
      skippedVariants: productSkippedVariants,
      errors: productErrors.slice(0, 5),
    });
  }

  return {
    ok: true,
    dryRun: Boolean(options.dryRun),
    mode,
    tag,
    batchSize,
    processedProducts,
    movedProducts,
    updatedVariants,
    skippedVariants,
    failedVariants,
    movedUnits,
    errors: errors.slice(0, 25),
    products: productSummaries,
    hasNextPage: Boolean(data.products.pageInfo?.hasNextPage),
    nextCursor: data.products.pageInfo?.endCursor || null,
  };
}
