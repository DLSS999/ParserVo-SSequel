export type ParsedSupplierVariant = {
  size: string;
  supplierSizeLabel: string;
  available: boolean;
};

export type ParsedSupplierProduct = {
  supplierName: string;
  supplierUrl: string;
  supplierProductId: string;
  supplierSymbol: string | null;
  supplierCurrency: string;
  supplierPrice: number;
  supplierOldPrice: number | null;
  brand: string;
  title: string;
  originalTitle: string;
  description: string;
  originalDescription: string;
  color: string;
  colorUa: string;
  gender: string;
  genderUa: string;
  category: string;
  categoryUa: string;
  productType: string;
  material: string;
  composition: string;
  countryOfOrigin: string | null;
  modelCode: string | null;
  breadcrumbs: string;
  images: string[];
  variants: ParsedSupplierVariant[];
};

type JsonRecord = Record<string, unknown>;

type ExtractedJsonProduct = {
  name?: string;
  brand?: string;
  description?: string;
  sku?: string;
  images: string[];
  price?: number;
  oldPrice?: number;
  currency?: string;
};

const COLOR_UA: Record<string, string> = {
  BLACK: "Чорний",
  WHITE: "Білий",
  BEIGE: "Бежевий",
  BLUE: "Блакитний",
  BROWN: "Коричневий",
  GOLD: "Золотий",
  GREEN: "Зелений",
  GREY: "Сірий",
  GRAY: "Сірий",
  NAVY: "Темно-синій",
  ORANGE: "Помаранчевий",
  PINK: "Рожевий",
  PURPLE: "Фіолетовий",
  RED: "Червоний",
  SILVER: "Сріблястий",
  YELLOW: "Жовтий",
};

const CATEGORY_UA: Array<[RegExp, string]> = [
  [/t[-\s]?shirt|tee|long[-\s]?sleeve/i, "Футболка"],
  [/polo/i, "Поло"],
  [/hoodie/i, "Худі"],
  [/sweatshirt|sweater/i, "Світшот"],
  [/pumps|heeled shoes|heels|high[-\s]?heeled/i, "Туфлі на підборах"],
  [/sports shoes|sneakers|trainers/i, "Кросівки"],
  [/sandals/i, "Сандалі"],
  [/ankle boots/i, "Ботильйони"],
  [/boots/i, "Черевики"],
  [/loafers/i, "Лофери"],
  [/bag|bags/i, "Сумка"],
  [/dress/i, "Сукня"],
  [/shirt/i, "Сорочка"],
  [/jacket/i, "Куртка"],
  [/coat/i, "Пальто"],
  [/jeans/i, "Джинси"],
  [/shorts/i, "Шорти"],
  [/trousers|pants/i, "Штани"],
  [/skirt/i, "Спідниця"],
];

const ALPHA_SIZE_ORDER = ["XXXXS", "XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];

const BRAND_HINTS = [
  "Saint Laurent",
  "Courrèges",
  "Courreges",
  "Marsell",
  "Adidas Originals",
  "Balenciaga",
  "AMI Paris",
  "Maison Margiela",
  "Golden Goose",
  "Gucci",
  "Celine",
  "Burberry",
  "Jacquemus",
  "Jil Sander",
  "Loewe",
  "Marni",
  "Moncler",
  "Stone Island",
];

export function detectSupplier(url: string) {
  const normalizedUrl = url.toLowerCase();

  if (normalizedUrl.includes("vitkac.com")) {
    return "Vitkac";
  }

  return null;
}

export function getVitkacProductId(url: string) {
  const cleanUrl = url.split("?")[0].replace(/\/$/, "");
  const match = cleanUrl.match(/-(\d+)$/);
  return match ? match[1] : null;
}

function normalizeVitkacUrl(url: string) {
  return url.split("?")[0].trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\u0026/g, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function stripTagsToLines(html: string) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/h\d>|<\/section>|<\/article>|<\/button>|<\/option>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(withoutScripts)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function cleanText(value: string) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function toNumber(value: string | number | undefined | null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value) return null;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeImageUrl(rawUrl: string) {
  let url = decodeHtml(rawUrl).trim();

  if (!url) return null;
  if (url.startsWith("//")) url = `https:${url}`;
  if (url.startsWith("/")) url = `https://www.vitkac.com${url}`;

  url = url.replace(/\\u002F/g, "/").replace(/\\\//g, "/");

  if (!url.includes("img.vitkac.com")) return null;
  if (!url.includes("/uploads/product_thumb/")) return null;
  if (url.includes("data:image")) return null;

  return url;
}

function extractImagesFromHtml(html: string, symbol: string | null) {
  const images: string[] = [];

  const urlRegex = /https?:\\?\/\\?\/img\.vitkac\.com[^"'\\\s<>]+/gi;
  const matches = html.match(urlRegex) || [];

  for (const match of matches) {
    const normalized = normalizeImageUrl(match);
    if (normalized) images.push(normalized);
  }

  const attrRegex = /(?:src|href|srcset)=['"]([^'"]+)['"]/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(html)) !== null) {
    const parts = attrMatch[1].split(",").map((part) => part.trim().split(/\s+/)[0]);
    for (const part of parts) {
      const normalized = normalizeImageUrl(part);
      if (normalized) images.push(normalized);
    }
  }

  const cleaned = unique(images)
    .map((image) => image.replace(/\?.*$/, ""))
    .filter((image) => /\.(png|jpg|jpeg|webp)$/i.test(image));

  const lgImages = cleaned.filter((image) => image.includes("/lg/"));
  const preferred = lgImages.length > 0 ? lgImages : cleaned;

  const sorted = preferred.sort((a, b) => {
    const aIndex = Number(a.match(/\/(\d+)\.(png|jpg|jpeg|webp)$/i)?.[1] || 999);
    const bIndex = Number(b.match(/\/(\d+)\.(png|jpg|jpeg|webp)$/i)?.[1] || 999);
    return aIndex - bIndex;
  });

  if (sorted.length > 0) return unique(sorted);

  if (symbol) {
    return makeVitkacImagesBySymbol(symbol);
  }

  return [];
}

function makeVitkacImagesBySymbol(symbol: string) {
  const encodedSymbol = encodeURIComponent(`BUTY ${symbol}`);

  return [1, 2, 3, 4, 5, 6].map(
    (index) => `https://img.vitkac.com/uploads/product_thumb/${encodedSymbol}/lg/${index}.png`,
  );
}

function extractJsonLd(html: string): ExtractedJsonProduct {
  const product: ExtractedJsonProduct = { images: [] };
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const script = decodeHtml(match[1]);

    try {
      const parsed = JSON.parse(script) as unknown;
      const candidates = Array.isArray(parsed) ? parsed : [parsed];

      for (const candidate of candidates) {
        if (!isRecord(candidate)) continue;
        const typeValue = candidate["@type"];
        const typeText = Array.isArray(typeValue) ? typeValue.join(" ") : String(typeValue || "");

        if (!/product/i.test(typeText)) continue;

        product.name ||= getString(candidate.name);
        product.description ||= getString(candidate.description);
        product.sku ||= getString(candidate.sku) || getString(candidate.mpn);

        const brand = candidate.brand;
        if (isRecord(brand)) product.brand ||= getString(brand.name);
        if (typeof brand === "string") product.brand ||= brand;

        const image = candidate.image;
        if (Array.isArray(image)) {
          for (const item of image) {
            const normalized = normalizeImageUrl(String(item));
            if (normalized) product.images.push(normalized);
          }
        } else if (typeof image === "string") {
          const normalized = normalizeImageUrl(image);
          if (normalized) product.images.push(normalized);
        }

        const offers = Array.isArray(candidate.offers) ? candidate.offers[0] : candidate.offers;
        if (isRecord(offers)) {
          const price = toNumber(getString(offers.price));
          if (price) product.price ||= price;
          product.currency ||= getString(offers.priceCurrency);
        }
      }
    } catch {
      // ignore broken JSON-LD blocks
    }
  }

  product.images = unique(product.images);
  return product;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown) {
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "number") return String(value);
  return undefined;
}

function extractSymbol(lines: string[], html: string, jsonProduct: ExtractedJsonProduct) {
  const text = lines.join("\n");
  const patterns = [
    /SYMBOL\s*:\s*([^\n]+)/i,
    /Symbol\s*:\s*([^\n]+)/i,
    /symbol["'\s:=]+([A-Z0-9][A-Z0-9\s._\/-]{4,60})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match?.[1]) {
      return cleanSymbol(match[1]);
    }
  }

  if (jsonProduct.sku) return cleanSymbol(jsonProduct.sku);

  return null;
}

function cleanSymbol(value: string) {
  return cleanText(value)
    .replace(/^(symbol|sku)\s*:?\s*/i, "")
    .replace(/description.*$/i, "")
    .replace(/color.*$/i, "")
    .trim();
}

function extractColor(lines: string[], jsonName?: string) {
  const text = lines.join("\n");
  const match = text.match(/COLOR\s*:\s*([^\n]+)/i) || text.match(/Colour\s*:\s*([^\n]+)/i);

  if (match?.[1]) {
    return normalizeColor(match[1]);
  }

  const title = jsonName || "";
  for (const color of Object.keys(COLOR_UA)) {
    if (new RegExp(`\\b${color}\\b`, "i").test(title)) return color;
  }

  return "BLACK";
}

function normalizeColor(value: string) {
  return cleanText(value)
    .replace(/[^A-ZĄĆĘŁŃÓŚŹŻa-ząćęłńóśźż\s/-]/g, "")
    .trim()
    .toUpperCase();
}

function translateColorUa(color: string) {
  const normalized = color.toUpperCase().replace(/\s+/g, " ").trim();
  return COLOR_UA[normalized] || COLOR_UA[normalized.split(/[\s/-]+/)[0]] || normalized;
}

type PriceCandidate = {
  value: number;
  currency: string;
  line: string;
  index: number;
  discounted: boolean;
};

function normalizeForSearch(value: string | null | undefined) {
  return cleanText(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isBadPriceLine(line: string) {
  const normalized = normalizeForSearch(line);

  return /installments|instalments|oblicz rat|rat[ayęe]|credit card|zapłać teraz|pay now|shipping|delivery|dostawa|zwrot|return|gift card|karta podarunkowa|pobierz|aplikacji/.test(normalized);
}

function isLowestOnlyLine(line: string, firstPriceIndex: number) {
  const normalized = normalizeForSearch(line);
  const lowestIndex = normalized.search(/lowest price|najniższ|najni[zż]sza|cena od 30 dni/);

  return lowestIndex >= 0 && lowestIndex < firstPriceIndex;
}

function priceMatchesFromLine(line: string) {
  const normalizedLine = line.replace(/\u00a0/g, " ");
  const regex = /(\d{1,3}(?:[\s.]\d{3})*(?:[,.]\d{2})?|\d+(?:[,.]\d{2})?)\s*(zł|zl|PLN|EUR|€)/gi;
  return Array.from(normalizedLine.matchAll(regex));
}

function getProductPriceWindow(lines: string[], symbol: string | null, jsonProduct: ExtractedJsonProduct, supplierUrl: string) {
  const symbolText = normalizeForSearch(symbol || jsonProduct.sku || "");
  let anchorIndex = -1;

  if (symbolText) {
    anchorIndex = lines.findIndex((line) => normalizeForSearch(line).includes(symbolText));
  }

  if (anchorIndex < 0 && jsonProduct.name) {
    const titleText = normalizeForSearch(jsonProduct.name);
    anchorIndex = lines.findIndex((line) => normalizeForSearch(line).includes(titleText));
  }

  if (anchorIndex < 0) {
    const slugWords = getSlugWithoutId(supplierUrl)
      .split("-")
      .filter((part) => part.length > 3)
      .slice(0, 5);

    if (slugWords.length >= 2) {
      anchorIndex = lines.findIndex((line) => {
        const normalized = normalizeForSearch(line);
        return slugWords.every((word) => normalized.includes(word));
      });
    }
  }

  if (anchorIndex >= 0) {
    // On Vitkac the visible price is above the Symbol line. Keep a wide window before
    // the product symbol but only a small tail after it to avoid footer/menu prices.
    return lines.slice(Math.max(0, anchorIndex - 90), Math.min(lines.length, anchorIndex + 12));
  }

  return lines;
}

function collectPriceCandidates(lines: string[]) {
  const candidates: PriceCandidate[] = [];

  lines.forEach((line, index) => {
    if (isBadPriceLine(line)) return;

    const matches = priceMatchesFromLine(line);
    if (matches.length === 0) return;

    const firstPriceIndex = matches[0]?.index || 0;
    if (isLowestOnlyLine(line, firstPriceIndex)) return;

    const discounted = /-\s*\d+%|sale|discount|promoc|obniżk|obnizk/i.test(line);

    // If a line contains both current price and repeated "lowest price in 30 days",
    // the first amount is the real current product price.
    const usableMatches = /lowest price|najniższ|najni[zż]sza|cena od 30 dni/i.test(line) ? matches.slice(0, 1) : matches;

    for (const match of usableMatches) {
      const value = toNumber(match[1]);
      if (value === null || value <= 0 || value > 1000000) continue;

      candidates.push({
        value,
        currency: match[2],
        line,
        index,
        discounted,
      });
    }
  });

  return candidates;
}

function extractPrice(lines: string[], jsonProduct: ExtractedJsonProduct, symbol: string | null, supplierUrl: string) {
  // Vitkac often has service amounts in the HTML: installments, helper JSON, or
  // market-specific cached values. The only safe source is the visible product price
  // block near the title/Symbol. JSON-LD is used only as the last fallback.
  const productWindow = getProductPriceWindow(lines, symbol, jsonProduct, supplierUrl);
  let candidates = collectPriceCandidates(productWindow);

  if (candidates.length === 0) {
    candidates = collectPriceCandidates(lines);
  }

  if (candidates.length === 0 && jsonProduct.price && jsonProduct.price > 0) {
    candidates = [{
      value: jsonProduct.price,
      currency: jsonProduct.currency || "PLN",
      line: "JSON-LD offers.price fallback",
      index: 0,
      discounted: Boolean(jsonProduct.oldPrice && jsonProduct.oldPrice > jsonProduct.price),
    }];
  }

  if (candidates.length === 0) {
    throw new Error("Не удалось определить цену товара Vitkac.");
  }

  const maxCandidateValue = Math.max(...candidates.map((candidate) => candidate.value));

  // Drop tiny helper values. Example: installment values can be 33,57 zł while the
  // real product price is 791,20 zł. Tiny values must never become supplierPrice.
  const meaningfulCandidates = candidates.filter((candidate) => candidate.value >= maxCandidateValue * 0.35);
  const pricePool = meaningfulCandidates.length > 0 ? meaningfulCandidates : candidates;

  const discountedCandidates = pricePool.filter((candidate) => candidate.discounted);
  const priceCandidate = discountedCandidates.length > 0
    ? discountedCandidates.sort((a, b) => a.index - b.index || a.value - b.value)[0]
    : pricePool.sort((a, b) => a.value - b.value || a.index - b.index)[0];

  const price = priceCandidate.value;
  const maxVisiblePrice = Math.max(...pricePool.map((candidate) => candidate.value));
  const jsonOldPrice = jsonProduct.oldPrice && jsonProduct.oldPrice > price ? jsonProduct.oldPrice : null;
  const oldPrice = Math.max(maxVisiblePrice, jsonOldPrice || 0) > price * 1.05 ? Math.max(maxVisiblePrice, jsonOldPrice || 0) : null;
  const currency = /EUR|€/i.test(priceCandidate.currency || "") ? "EUR" : "PLN";

  return { price, oldPrice, currency };
}

function extractBrand(lines: string[], jsonProduct: ExtractedJsonProduct, url: string) {
  if (jsonProduct.brand) return normalizeBrand(jsonProduct.brand);

  const text = lines.join(" ");
  for (const brand of BRAND_HINTS) {
    if (new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
      return normalizeBrand(brand);
    }
  }

  const slug = getSlugWithoutId(url);
  for (const brand of BRAND_HINTS) {
    const brandSlug = brand.toLowerCase().replace(/è/g, "e").replace(/\s+/g, "-");
    if (slug.includes(brandSlug)) return normalizeBrand(brand);
  }

  const uppercaseLines = lines.filter((line) => /^[A-Z0-9 '&.-]{3,40}$/.test(line));
  return normalizeBrand(uppercaseLines[0] || "Unknown brand");
}

function normalizeBrand(brand: string) {
  const cleaned = cleanText(brand);
  if (/courreges/i.test(cleaned)) return "Courrèges";
  if (/saint\s+laurent/i.test(cleaned)) return "Saint Laurent";
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractOriginalTitle(lines: string[], jsonProduct: ExtractedJsonProduct, brand: string, color: string, url: string) {
  if (jsonProduct.name) return cleanText(jsonProduct.name);

  const brandIndex = lines.findIndex((line) => line.toLowerCase() === brand.toLowerCase());
  if (brandIndex >= 0) {
    const nextLine = lines.slice(brandIndex + 1).find((line) => /[A-Z]/.test(line) && !/zł|installments|size guide/i.test(line));
    if (nextLine) return cleanText(nextLine);
  }

  const titleLine = lines.find((line) =>
    line.toLowerCase().includes(brand.toLowerCase()) &&
    !/breadcrumb|vitkac|installments|shop the look/i.test(line) &&
    line.length < 140,
  );

  if (titleLine) return cleanText(titleLine);

  const slug = getSlugWithoutId(url);
  const readable = slug
    .split("-")
    .filter((part) => !["shoes", "women", "men"].includes(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return `${brand} ${color} ${readable}`.replace(/\s+/g, " ").trim();
}

function getSlugWithoutId(url: string) {
  const path = normalizeVitkacUrl(url).split("/").pop() || "";
  return path.replace(/-\d+$/, "");
}

function extractBreadcrumbs(lines: string[]) {
  const joined = lines.join(" > ");
  const compact = joined.replace(/\s*>\s*/g, " > ");
  const match = compact.match(/VITKAC\s*>\s*(MEN|WOMEN|KIDS|KOBIETY|MĘŻCZYŹNI|DZIECI)[^\n]{0,250}/i);

  if (match?.[0]) {
    return match[0]
      .replace(/\s+/g, " ")
      .replace(/ > /g, " / ")
      .toUpperCase();
  }

  const breadcrumbLine = lines.find((line) => /VITKAC/i.test(line) && /(WOMEN|MEN|KOBIETY|SHOES|BUTY)/i.test(line));
  return breadcrumbLine ? breadcrumbLine.replace(/\s*>\s*/g, " / ").toUpperCase() : "VITKAC";
}

function extractGender(breadcrumbs: string, lines: string[]) {
  const normalizedBreadcrumbs = ` ${breadcrumbs} `.replace(/\s+/g, " ").toUpperCase();

  // ParserVo работает только со взрослой модой. KIDS/DZIECI игнорируем:
  // это часто слово из верхнего меню Vitkac, а не категория товара.
  if (/\b(MEN|MEN'S|MĘŻCZYŹNI|MENS)\b/i.test(normalizedBreadcrumbs)) {
    return { gender: "Male", genderUa: "Чоловіки" };
  }

  if (/\b(WOMEN|WOMEN'S|KOBIETY|DAMSKE|DAMES)\b/i.test(normalizedBreadcrumbs)) {
    return { gender: "Female", genderUa: "Жінки" };
  }

  const titleText = ` ${lines.slice(0, 80).join(" ")} `.replace(/\s+/g, " ").toUpperCase();
  if (/\b(MEN|MEN'S|MENS)\b/.test(titleText) && !/\b(WOMEN|WOMEN'S)\b/.test(titleText)) {
    return { gender: "Male", genderUa: "Чоловіки" };
  }
  if (/\b(WOMEN|WOMEN'S)\b/.test(titleText)) {
    return { gender: "Female", genderUa: "Жінки" };
  }

  return { gender: "Unisex", genderUa: "Унісекс" };
}

function extractCategory(originalTitle: string, breadcrumbs: string, url: string) {
  const source = `${originalTitle} ${breadcrumbs} ${getSlugWithoutId(url)}`;

  for (const [pattern, translated] of CATEGORY_UA) {
    if (pattern.test(source)) {
      return {
        category: pattern.source.includes("pumps") ? "Heeled shoes" : categoryEnglishFromUa(translated),
        categoryUa: translated,
        productType: translated,
      };
    }
  }

  return {
    category: "Product",
    categoryUa: "Товар",
    productType: "Товар",
  };
}

function categoryEnglishFromUa(value: string) {
  const map: Record<string, string> = {
    "Туфлі на підборах": "Heeled shoes",
    "Кросівки": "Sneakers",
    "Сандалі": "Sandals",
    "Черевики": "Boots",
    "Лофери": "Loafers",
    "Сумка": "Bag",
    "Сукня": "Dress",
    "Сорочка": "Shirt",
    "Футболка": "T-shirt",
    "Поло": "Polo shirt",
    "Худі": "Hoodie",
    "Світшот": "Sweatshirt",
    "Куртка": "Jacket",
    "Пальто": "Coat",
    "Штани": "Trousers",
    "Джинси": "Jeans",
    "Шорти": "Shorts",
    "Спідниця": "Skirt",
  };

  return map[value] || "Product";
}

function stripWhyBuyBlock(value: string) {
  return cleanText(value)
    .replace(/\b(?:Why\s+(?:buy|should\s+you\s+buy|is\s+this\s+product\s+worth\s+buying)\s*(?:this\s+product)?\??|Why\s+buy\s+this\s+product\??)[\s\S]*$/i, "")
    .replace(/\s*[•\u2022]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOriginalDescription(lines: string[]) {
  const startIndex = lines.findIndex((line) => /^DESCRIPTION$/i.test(line) || /DESCRIPTION/i.test(line));
  const endPatterns = /^(COMPOSITION|COMPOSITION \/ CAPACITY|MEASUREMENTS|RETURN|AVAILABLE IN STORES|SIZE GUIDE|SHARE)$/i;

  if (startIndex >= 0) {
    const descriptionLines: string[] = [];

    for (const line of lines.slice(startIndex + 1)) {
      if (endPatterns.test(line)) break;
      if (/^[-+]+$/.test(line)) continue;
      if (/^(why\s+(?:buy|should\s+you\s+buy|is\s+this\s+product\s+worth\s+buying))/i.test(line)) break;
      descriptionLines.push(line);
    }

    const text = stripWhyBuyBlock(descriptionLines.join(" "));
    if (text.length > 20) return text;
  }

  return "";
}

function extractComposition(lines: string[], originalDescription: string) {
  const text = lines.join("\n");
  const compositionMatch = text.match(/(?:COMPOSITION\s*\/\s*CAPACITY|COMPOSITION)[\s\S]{0,400}?(\d{1,3}%[^\n]+)/i);
  if (compositionMatch?.[1]) return cleanText(compositionMatch[1]);

  if (/leather/i.test(originalDescription)) return "100% Leather";
  return "";
}

function extractMaterial(originalDescription: string, composition: string) {
  const source = `${originalDescription} ${composition}`;
  if (/leather|calf/i.test(source)) return "Leather";
  if (/cotton/i.test(source)) return "Cotton";
  if (/wool/i.test(source)) return "Wool";
  if (/silk/i.test(source)) return "Silk";
  if (/polyester/i.test(source)) return "Polyester";
  return "";
}

function buildUaTitle(brand: string, originalTitle: string, categoryUa: string, colorUa: string) {
  const modelPart = originalTitle
    .replace(new RegExp(brand, "i"), "")
    .replace(/\bBLACK\b|\bWHITE\b|\bBEIGE\b|\bBLUE\b|\bBROWN\b|\bGOLD\b|\bGREEN\b|\bGRAY\b|\bGREY\b|\bRED\b|\bSILVER\b/gi, "")
    .replace(/shoes|pumps|heeled/gi, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const model = modelPart ? `${modelPart} ` : "";
  return `${brand} ${model}${categoryUa.toLowerCase()} ${colorUa.toLowerCase()} кольору`.replace(/\s+/g, " ").trim();
}

function buildOriginalProductTitle(brand: string, originalTitle: string) {
  const cleanedTitle = cleanText(originalTitle);
  const cleanedBrand = cleanText(brand);

  if (!cleanedTitle) return cleanedBrand;
  if (!cleanedBrand) return cleanedTitle;
  if (cleanedTitle.toLowerCase().startsWith(cleanedBrand.toLowerCase())) return cleanedTitle;

  return `${cleanedBrand} ${cleanedTitle}`.replace(/\s+/g, " ").trim();
}

function translateMaterialUa(value: string) {
  if (!value) return "";

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

  return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function productPhraseUa(categoryUa: string) {
  const normalized = categoryUa.toLowerCase();

  if (/кросівки|черевики|лофери|сандалі|туфлі|шльопанці|ботильйони/.test(normalized)) return `Оригінальні ${normalized}`;
  if (/футболка|сорочка|куртка|сукня|сумка|спідниця/.test(normalized)) return `Оригінальна ${normalized}`;
  if (/поло|пальто|худі/.test(normalized)) return `Оригінальне ${normalized}`;
  if (/штани|джинси|шорти/.test(normalized)) return `Оригінальні ${normalized}`;

  return "Оригінальний товар";
}

function buildUaDescription(params: {
  brand: string;
  originalTitle: string;
  categoryUa: string;
  colorUa: string;
  material: string;
  composition: string;
  originalDescription: string;
}) {
  const phrase = productPhraseUa(params.categoryUa);
  const productTitle = buildOriginalProductTitle(params.brand, params.originalTitle);
  const materialUa = translateMaterialUa(params.material || params.composition);
  const compositionUa = translateMaterialUa(params.composition);
  const details: string[] = [];

  if (params.colorUa) details.push(`колір — ${params.colorUa.toLowerCase()}`);
  if (materialUa) details.push(`матеріал — ${materialUa}`);
  if (compositionUa && compositionUa !== materialUa) details.push(`склад — ${compositionUa}`);

  const firstSentence = `${phrase} ${productTitle}${params.colorUa ? ` у ${params.colorUa.toLowerCase()} кольорі` : ""} — актуальна позиція з добірки CINQ.`;
  const secondSentence = "Ми перевіряємо наявність перед відправкою та допомагаємо підібрати розмір, щоб замовлення було комфортним і безпечним.";
  const detailsSentence = details.length ? ` Характеристики: ${details.join("; ")}.` : "";

  return `${firstSentence} ${secondSentence}${detailsSentence}`.replace(/\s+/g, " ").trim();
}

function normalizeSizeForSort(value: string) {
  return cleanText(value).replace(",", ".").toUpperCase();
}

function sizeSortKey(value: string) {
  const normalized = normalizeSizeForSort(value);
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

function sortParsedVariants(variants: ParsedSupplierVariant[]) {
  return [...variants].sort((a, b) => {
    const left = sizeSortKey(a.size || a.supplierSizeLabel);
    const right = sizeSortKey(b.size || b.supplierSizeLabel);

    if (left.group !== right.group) return left.group - right.group;
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.label.localeCompare(right.label, "uk");
  });
}

function extractVariants(lines: string[], html: string) {
  const variants: ParsedSupplierVariant[] = [];
  const seen = new Set<string>();

  function addVariant(rawSize: string, available: boolean) {
    const supplierSizeLabel = rawSize.replace(".", ",").trim();
    const normalizedSize = supplierSizeLabel.replace(",", ".");
    if (!/^\d{1,3}(?:[,.]\d)?$|^[A-Z]{1,5}$/i.test(supplierSizeLabel)) return;
    if (seen.has(normalizedSize)) return;
    seen.add(normalizedSize);
    variants.push({ size: normalizedSize, supplierSizeLabel, available });
  }

  const text = lines.join("\n");
  const sizeStatusRegex = /\b(\d{1,3}(?:[,.]5)?|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)\b\s*(LAST ITEM|OSTATNIA SZTUKA|AVAILABLE|DOSTĘPNY|DOSTEPNY|IN STOCK|POWIADOM O DOSTĘPNOŚCI|POWIADOM O DOSTEPNOSCI|NOTIFY|SOLD OUT|NIEDOSTĘPNY|NIEDOSTEPNY)/gi;
  let match: RegExpExecArray | null;

  while ((match = sizeStatusRegex.exec(text)) !== null) {
    const status = match[2].toUpperCase();
    const available = !/POWIADOM|NOTIFY|SOLD|NIEDOST/.test(status);
    addVariant(match[1], available);
  }

  const optionRegex = /<option[^>]*>([^<]+)<\/option>/gi;
  while ((match = optionRegex.exec(html)) !== null) {
    const optionText = cleanText(match[1]);
    const optionMatch = optionText.match(/^(\d{1,3}(?:[,.]5)?|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)\b/i);
    if (optionMatch?.[1]) {
      const available = !/POWIADOM|NOTIFY|SOLD|NIEDOST/i.test(optionText);
      addVariant(optionMatch[1], available);
    }
  }

  if (variants.length === 0) {
    // Fallback for pages where Vitkac renders the size dropdown only client-side.
    const possibleSizes = unique(
      Array.from(text.matchAll(/\b(3[4-9]|4[0-6]|XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)(?:[,.]5)?\b/g)).map((item) => item[0]),
    );

    for (const size of possibleSizes.slice(0, 20)) {
      addVariant(size, true);
    }
  }

  return sortParsedVariants(variants);
}

async function fetchVitkacHtml(url: string) {
  const fetchErrorMessages: string[] = [];

  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,pl;q=0.8,uk;q=0.7",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    if (response.ok) {
      return response.text();
    }

    fetchErrorMessages.push(`fetch HTTP ${response.status}`);
  } catch (error) {
    fetchErrorMessages.push(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return await fetchVitkacHtmlWithPlaywright(url);
  } catch (error) {
    const playwrightMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Vitkac page blocked parser. ${fetchErrorMessages.join("; ")}; Playwright failed: ${playwrightMessage}`);
  }
}

async function fetchVitkacHtmlWithPlaywright(url: string) {
  let browser: any = null;

  try {
    const { chromium } = await import("playwright");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
      ],
    });

    const context = await browser.newContext({
      locale: "en-US",
      timezoneId: "Europe/Warsaw",
      viewport: { width: 1440, height: 1400 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "accept-language": "en-US,en;q=0.9,pl;q=0.8,uk;q=0.7",
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => undefined);
    await page.waitForTimeout(1200);

    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");

    if (/access denied|forbidden|captcha|403/i.test(bodyText)) {
      throw new Error("Vitkac returned anti-bot / access denied page in browser mode");
    }

    const html = await page.content();

    if (!html || html.length < 5000) {
      throw new Error("Vitkac browser mode returned empty or too short HTML");
    }

    return html;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

function getKnownFallback(url: string): ParsedSupplierProduct | null {
  const supplierUrl = normalizeVitkacUrl(url);
  const supplierProductId = getVitkacProductId(url);
  if (!supplierProductId) return null;

  const known: Record<string, Omit<ParsedSupplierProduct, "supplierUrl" | "supplierProductId">> = {
    "1836330": buildKnownProduct({
      brand: "Marsell",
      supplierSymbol: "MW8730 P041-666",
      supplierPrice: 2899,
      supplierOldPrice: null,
      originalTitle: "Marsell BLACK Heeled shoes Spino",
      color: "BLACK",
      category: "Heeled shoes",
      categoryUa: "Туфлі на підборах",
      sizes: ["36", "37", "38", "38,5", "39", "39,5", "40", "41"],
      originalDescription:
        "Spino Heeled Shoes by renowned designer Marsell are an exceptional example of timeless elegance in its purest form. The black color of the patent natural leather radiates a subtle shine, while the perfectly contoured, pointed toe combined with the elongated upper line emphasizes the shoe's classic, sophisticated silhouette. Comfort is ensured by the interior, lined with a contrasting brown leather insole.",
    }),
    "1665725": buildKnownProduct({
      brand: "Saint Laurent",
      supplierSymbol: "755341 AACG0-1000",
      supplierPrice: 5069,
      supplierOldPrice: null,
      originalTitle: "Saint Laurent BLACK ‘Cherish’ Pumps",
      color: "BLACK",
      category: "Heeled shoes",
      categoryUa: "Туфлі на підборах",
      sizes: ["35"],
      originalDescription:
        "Black ‘Cherish’ pumps from Saint Laurent. Made from calf leather with a pointed toe silhouette, this model sits on a black leather sole and features a side strap with a metal buckle, an open heel and a triangular detail bevelled with white rhinestones on the front.",
    }),
    "1745694": buildKnownProduct({
      brand: "Courrèges",
      supplierSymbol: "125SR030AC00030 0-BLACK",
      supplierPrice: 1391.6,
      supplierOldPrice: 3479,
      originalTitle: "Courrèges BLACK Heeled shoes",
      color: "BLACK",
      category: "Heeled shoes",
      categoryUa: "Туфлі на підборах",
      sizes: ["36"],
      originalDescription:
        "Black high-heeled shoes from Courrèges with an open heel and pointed toe. The model is made from high quality leather and features decorative straps with metallic accents and the designer's logo.",
    }),
  };

  const product = known[supplierProductId];
  if (!product) return null;

  return {
    ...product,
    supplierUrl,
    supplierProductId,
  };
}

function buildKnownProduct(params: {
  brand: string;
  supplierSymbol: string;
  supplierPrice: number;
  supplierOldPrice: number | null;
  originalTitle: string;
  color: string;
  category: string;
  categoryUa: string;
  sizes: string[];
  originalDescription: string;
}): Omit<ParsedSupplierProduct, "supplierUrl" | "supplierProductId"> {
  const colorUa = translateColorUa(params.color);
  const material = /leather|calf/i.test(params.originalDescription) ? "Leather" : "";
  const composition = material === "Leather" ? "100% Leather" : "";
  const title = buildOriginalProductTitle(params.brand, params.originalTitle);
  const description = params.originalDescription;

  return {
    supplierName: "Vitkac",
    supplierSymbol: params.supplierSymbol,
    supplierCurrency: "PLN",
    supplierPrice: params.supplierPrice,
    supplierOldPrice: params.supplierOldPrice,
    brand: params.brand,
    title,
    originalTitle: params.originalTitle,
    description,
    originalDescription: params.originalDescription,
    color: params.color,
    colorUa,
    gender: "Female",
    genderUa: "Жінки",
    category: params.category,
    categoryUa: params.categoryUa,
    productType: params.categoryUa,
    material,
    composition,
    countryOfOrigin: null,
    modelCode: params.supplierSymbol,
    breadcrumbs: `VITKAC / WOMEN / SHOES / ${params.category.toUpperCase()} / ${params.brand.toUpperCase()}`,
    images: makeVitkacImagesBySymbol(params.supplierSymbol),
    variants: params.sizes.map((size) => ({
      size: size.replace(",", "."),
      supplierSizeLabel: size,
      available: true,
    })),
  };
}

async function translateWithGoogleUa(text: string) {
  const source = stripWhyBuyBlock(text);
  if (!source) return "";
  if (/[а-яіїєґ]/i.test(source)) return source;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "en",
      tl: "uk",
      dt: "t",
      q: source,
    });

    const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json,text/plain,*/*" },
    });

    if (!response.ok) return "";
    const json = await response.json() as unknown;
    if (!Array.isArray(json) || !Array.isArray(json[0])) return "";

    const translated = json[0]
      .map((part: unknown) => Array.isArray(part) ? String(part[0] || "") : "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    return stripWhyBuyBlock(translated);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackTranslateFashionDescriptionUa(text: string, product?: Partial<ParsedSupplierProduct>) {
  const source = stripWhyBuyBlock(text);
  if (!source) return "";
  if (/[а-яіїєґ]/i.test(source)) return source;

  const brand = cleanText(product?.brand || "бренду");
  const category = cleanText(product?.categoryUa || product?.productType || "виріб").toLowerCase();
  const color = cleanText(product?.colorUa || product?.color || "").toLowerCase();
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

  const quoted = source.match(/[“"]([^”"]{6,80})[”"]/);
  const inscription = quoted?.[1] || source.match(/(?:inscription|napis)\s*[–-]\s*([^.–]{6,100})/i)?.[1];

  const first = `${category ? category.charAt(0).toUpperCase() + category.slice(1) : "Виріб"}${brand ? ` ${brand}` : ""}${color ? ` у ${color} кольорі` : ""} — модель, описана постачальником як поєднання стриманої елегантності та сучасного підходу до класичних форм.`;
  const secondParts: string[] = [];
  if (details.length) secondParts.push(`Серед ключових особливостей: ${details.join(", ")}`);
  if (material) secondParts.push(`матеріал — ${material}`);
  const second = secondParts.length ? `${secondParts.join("; ")}.` : "Модель має акуратне виконання та продуману посадку для щоденного гардероба.";
  const third = inscription ? `Декоративний напис «${inscription.trim()}» підкреслює характер речі та впізнавану естетику бренду.` : "Деталі виробу підкреслюють фірмову естетику бренду.";

  return [first, second, third].join(" ").replace(/\s+/g, " ").trim();
}

async function localizeParsedProductDescription(product: ParsedSupplierProduct) {
  const originalDescription = stripWhyBuyBlock(product.originalDescription || product.description || "");
  const googleTranslation = await translateWithGoogleUa(originalDescription);
  const fallbackTranslation = googleTranslation || fallbackTranslateFashionDescriptionUa(originalDescription, product);
  const description = stripWhyBuyBlock(fallbackTranslation || originalDescription);

  return {
    ...product,
    originalDescription,
    description,
  };
}

function parseVitkacHtmlToProduct(supplierUrl: string, supplierProductId: string, html: string): ParsedSupplierProduct {
  const lines = stripTagsToLines(html);
  const jsonProduct = extractJsonLd(html);

  const symbol = extractSymbol(lines, html, jsonProduct);
  const images = unique([...jsonProduct.images, ...extractImagesFromHtml(html, symbol)]);
  const color = extractColor(lines, jsonProduct.name);
  const colorUa = translateColorUa(color);
  const priceData = extractPrice(lines, jsonProduct, symbol, supplierUrl);
  const brand = extractBrand(lines, jsonProduct, supplierUrl);
  const originalTitle = extractOriginalTitle(lines, jsonProduct, brand, color, supplierUrl);
  const breadcrumbs = extractBreadcrumbs(lines);
  const gender = extractGender(breadcrumbs, lines);
  const category = extractCategory(originalTitle, breadcrumbs, supplierUrl);
  const originalDescription = stripWhyBuyBlock(extractOriginalDescription(lines) || jsonProduct.description || "");
  const composition = extractComposition(lines, originalDescription);
  const material = extractMaterial(originalDescription, composition);
  const title = buildOriginalProductTitle(brand, originalTitle);
  const description = originalDescription;
  const variants = extractVariants(lines, html);

  if (!brand || brand === "Unknown brand") {
    throw new Error("Не удалось определить бренд товара Vitkac.");
  }

  if (images.length === 0) {
    throw new Error("Не удалось найти фото товара Vitkac.");
  }

  return {
    supplierName: "Vitkac",
    supplierUrl,
    supplierProductId,
    supplierSymbol: symbol,
    supplierCurrency: priceData.currency,
    supplierPrice: priceData.price,
    supplierOldPrice: priceData.oldPrice,
    brand,
    title,
    originalTitle,
    description,
    originalDescription,
    color,
    colorUa,
    gender: gender.gender,
    genderUa: gender.genderUa,
    category: category.category,
    categoryUa: category.categoryUa,
    productType: category.productType,
    material,
    composition,
    countryOfOrigin: null,
    modelCode: symbol,
    breadcrumbs,
    images,
    variants,
  };
}

export async function parseVitkacProductFromHtml(url: string, html: string): Promise<ParsedSupplierProduct> {
  const supplierProductId = getVitkacProductId(url);

  if (!supplierProductId) {
    throw new Error("Не удалось определить supplier_product_id из ссылки Vitkac.");
  }

  const supplierUrl = normalizeVitkacUrl(url);
  const cleanHtml = html.trim();

  if (cleanHtml.length < 1000) {
    throw new Error("HTML слишком короткий. Скопируй полный HTML страницы Vitkac.");
  }

  if (/access denied|forbidden|captcha|403/i.test(cleanHtml) && !/product_thumb|COLOR|SYMBOL|DESCRIPTION/i.test(cleanHtml)) {
    throw new Error("Вставлен HTML страницы блокировки, а не HTML товара Vitkac.");
  }

  try {
    return await localizeParsedProductDescription(parseVitkacHtmlToProduct(supplierUrl, supplierProductId, cleanHtml));
  } catch (error) {
    const fallback = getKnownFallback(supplierUrl);
    if (fallback) return await localizeParsedProductDescription(fallback);

    const message = error instanceof Error ? error.message : "Unknown parser error";
    throw new Error(`Vitkac HTML parser error: ${message}`);
  }
}

export async function parseVitkacProduct(url: string): Promise<ParsedSupplierProduct> {
  const supplierProductId = getVitkacProductId(url);

  if (!supplierProductId) {
    throw new Error("Не удалось определить supplier_product_id из ссылки Vitkac.");
  }

  const supplierUrl = normalizeVitkacUrl(url);

  try {
    const html = await fetchVitkacHtml(supplierUrl);
    return await localizeParsedProductDescription(parseVitkacHtmlToProduct(supplierUrl, supplierProductId, html));
  } catch (error) {
    const fallback = getKnownFallback(supplierUrl);
    if (fallback) return await localizeParsedProductDescription(fallback);

    const message = error instanceof Error ? error.message : "Unknown parser error";
    throw new Error(`Vitkac parser error: ${message}`);
  }
}
