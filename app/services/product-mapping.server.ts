import type { ParsedMarketplaceProduct } from "./media.server";

function text(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function mappingSource(product: ParsedMarketplaceProduct) {
  return ` ${[
    product.title,
    product.category,
    product.productType,
    product.productCategory,
    product.sourceUrl,
  ].filter(Boolean).join(" ")} `.toLowerCase();
}

export type ProductKind =
  | "ankle_boots" | "sneakers" | "loafers" | "moccasins" | "mules"
  | "clogs" | "sandals" | "slides" | "boots" | "shoes"
  | "backpack" | "shopper" | "shoulder_bag" | "bag" | "belt"
  | "scarf" | "socks" | "cap" | "hat" | "wallet" | "sunglasses"
  | "swim_shorts" | "shorts" | "jeans" | "trousers" | "down_jacket"
  | "jacket" | "coat" | "cardigan" | "turtleneck" | "zip_hoodie"
  | "hoodie" | "sweatshirt" | "sweater" | "longsleeve" | "polo"
  | "tshirt" | "shirt" | "bodysuit" | "top" | "dress" | "skirt"
  | "suit" | "vest" | "underwear" | "other";

export function detectProductKind(product: ParsedMarketplaceProduct): ProductKind {
  const title = ` ${text(product.title).toLowerCase()} `;
  const source = mappingSource(product);

  const detect = (value: string): ProductKind | "" => {
    if (/ankle boots?|ботильйон/.test(value)) return "ankle_boots";
    if (/sneakers?|trainers?|sports shoes?|кросівк/.test(value)) return "sneakers";
    if (/loafers?|лофер/.test(value)) return "loafers";
    if (/moccasins?|мокасин/.test(value)) return "moccasins";
    if (/\bmules?\b|мюлі/.test(value)) return "mules";
    if (/\bclogs?\b|сабо/.test(value)) return "clogs";
    if (/sandals?|сандал|босоніж/.test(value)) return "sandals";
    if (/flip flops?|slides?|slippers?|шльопанц/.test(value)) return "slides";
    if (/\bboots?\b|черевик/.test(value)) return "boots";
    if (/pumps?|heeled shoes?|heels?|туфл/.test(value)) return "shoes";

    if (/backpacks?|рюкзак/.test(value)) return "backpack";
    if (/shoppers?|tote bags?|шопер/.test(value)) return "shopper";
    if (/shoulder bags?|сумк[аи] на плече/.test(value)) return "shoulder_bag";
    if (/wallets?|cardholders?|гаманц/.test(value)) return "wallet";
    if (/sunglasses?|сонцезахисні окуляри/.test(value)) return "sunglasses";
    if (/handbags?|bags?|сумк/.test(value)) return "bag";
    if (/belts?|ремен/.test(value)) return "belt";
    if (/scarves?|shawls?|шарф/.test(value)) return "scarf";
    if (/socks?|шкарпет/.test(value)) return "socks";
    if (/caps?|кепк/.test(value)) return "cap";
    if (/hats?|beanies?|шапк|капелюх/.test(value)) return "hat";

    if (/\bswim shorts?\b|\bswimming shorts?\b|плавк/.test(value)) return "swim_shorts";
    if (/\bshorts\b|шорти/.test(value)) return "shorts";
    if (/jeans|джинс/.test(value)) return "jeans";
    if (/trousers?|pants|брюк|штани/.test(value)) return "trousers";
    if (/down jacket|puffer|пухов/.test(value)) return "down_jacket";
    if (/bomber jackets?|jackets?|куртк/.test(value)) return "jacket";
    if (/coats?|пальт/.test(value)) return "coat";
    if (/cardigans?|кардиган/.test(value)) return "cardigan";
    if (/turtlenecks?|roll neck|high neck|водолаз/.test(value)) return "turtleneck";
    if (/zip[-\s]?hoodie|зіп[-\s]?худі/.test(value)) return "zip_hoodie";
    if (/hoodies?|худі/.test(value)) return "hoodie";
    if (/\bsweatshirts?\b|світшот/.test(value)) return "sweatshirt";
    if (/\bsweaters?\b|\bpullovers?\b|\bknitwear\b|светр/.test(value)) return "sweater";
    if (/\bpolos?\b|поло/.test(value)) return "polo";
    if (/\bt[-\s]?shirts?\b|\btees?\b|футболк/.test(value)) return "tshirt";
    if (/\blong[-\s]?sleeves?\b|лонгслів/.test(value)) return "longsleeve";
    if (/\bshirts?\b|сорочк/.test(value)) return "shirt";
    if (/bodysuits?|боді/.test(value)) return "bodysuit";
    if (/\btops?\b|топ/.test(value)) return "top";
    if (/\bdresses?\b|сукн/.test(value)) return "dress";
    if (/\bskirts?\b|спідниц/.test(value)) return "skirt";
    if (/\bsuits?\b|костюм/.test(value)) return "suit";
    if (/\bvests?\b|жилет/.test(value)) return "vest";
    if (/underwear|lingerie|briefs?|boxers?|трус/.test(value)) return "underwear";
    return "";
  };

  return detect(title) || detect(source) || "other";
}

const TYPE_UA: Record<ProductKind, string> = {
  ankle_boots: "Ботильйони", sneakers: "Кросівки", loafers: "Лофери",
  moccasins: "Мокасини", mules: "Мюлі", clogs: "Сабо", sandals: "Сандалі",
  slides: "Шльопанці", boots: "Черевики", shoes: "Туфлі", backpack: "Рюкзаки",
  shopper: "Шопери", shoulder_bag: "Сумки на плече", bag: "Сумки", belt: "Ремені",
  scarf: "Шарфи", socks: "Шкарпетки", cap: "Кепки", hat: "Шапки",
  wallet: "Гаманці", sunglasses: "Сонцезахисні окуляри", swim_shorts: "Шорти для плавання",
  shorts: "Шорти", jeans: "Джинси", trousers: "Брюки", down_jacket: "Пуховики",
  jacket: "Куртки", coat: "Пальта", cardigan: "Кардигани", turtleneck: "Водолазки",
  zip_hoodie: "Зіп-худі", hoodie: "Худі", sweatshirt: "Світшоти", sweater: "Светри",
  longsleeve: "Лонгсліви", polo: "Поло", tshirt: "Футболки", shirt: "Сорочки",
  bodysuit: "Боді", top: "Топи", dress: "Сукні", skirt: "Спідниці", suit: "Костюми",
  vest: "Жилети", underwear: "Нижня білизна", other: "Інше",
};

const NAME_TYPE_UA: Record<ProductKind, string> = {
  ankle_boots: "Ботильйони", sneakers: "Кросівки", loafers: "Лофери",
  moccasins: "Мокасини", mules: "Мюлі", clogs: "Сабо", sandals: "Сандалі",
  slides: "Шльопанці", boots: "Черевики", shoes: "Туфлі", backpack: "Рюкзак",
  shopper: "Шопер", shoulder_bag: "Сумка на плече", bag: "Сумка", belt: "Ремінь",
  scarf: "Шарф", socks: "Шкарпетки", cap: "Кепка", hat: "Шапка", wallet: "Гаманець",
  sunglasses: "Сонцезахисні окуляри", swim_shorts: "Шорти для плавання", shorts: "Шорти",
  jeans: "Джинси", trousers: "Брюки", down_jacket: "Пуховик", jacket: "Куртка",
  coat: "Пальто", cardigan: "Кардиган", turtleneck: "Водолазка", zip_hoodie: "Зіп-худі",
  hoodie: "Худі", sweatshirt: "Світшот", sweater: "Светр", longsleeve: "Лонгслів",
  polo: "Поло", tshirt: "Футболка", shirt: "Сорочка", bodysuit: "Боді", top: "Топ",
  dress: "Сукня", skirt: "Спідниця", suit: "Костюм", vest: "Жилет",
  underwear: "Нижня білизна", other: "Виріб",
};

const TAXONOMY_PATH: Record<ProductKind, string> = {
  ankle_boots: "Apparel & Accessories > Shoes > Boots",
  sneakers: "Apparel & Accessories > Shoes > Sneakers",
  loafers: "Apparel & Accessories > Shoes > Loafers",
  moccasins: "Apparel & Accessories > Shoes > Loafers",
  mules: "Apparel & Accessories > Shoes > Mules",
  clogs: "Apparel & Accessories > Shoes > Clogs",
  sandals: "Apparel & Accessories > Shoes > Sandals",
  slides: "Apparel & Accessories > Shoes > Slippers",
  boots: "Apparel & Accessories > Shoes > Boots",
  shoes: "Apparel & Accessories > Shoes",
  backpack: "Apparel & Accessories > Handbags, Wallets & Cases > Backpacks",
  shopper: "Apparel & Accessories > Handbags, Wallets & Cases > Handbags",
  shoulder_bag: "Apparel & Accessories > Handbags, Wallets & Cases > Handbags",
  bag: "Apparel & Accessories > Handbags, Wallets & Cases > Handbags",
  belt: "Apparel & Accessories > Clothing Accessories > Belts",
  scarf: "Apparel & Accessories > Clothing Accessories > Scarves & Shawls",
  socks: "Apparel & Accessories > Clothing > Socks",
  cap: "Apparel & Accessories > Clothing Accessories > Hats",
  hat: "Apparel & Accessories > Clothing Accessories > Hats",
  wallet: "Apparel & Accessories > Handbags, Wallets & Cases > Wallets & Money Clips",
  sunglasses: "Apparel & Accessories > Clothing Accessories > Sunglasses",
  swim_shorts: "Apparel & Accessories > Clothing > Swimwear",
  shorts: "Apparel & Accessories > Clothing > Shorts",
  jeans: "Apparel & Accessories > Clothing > Pants > Jeans",
  trousers: "Apparel & Accessories > Clothing > Pants > Trousers",
  down_jacket: "Apparel & Accessories > Clothing > Outerwear > Coats & Jackets",
  jacket: "Apparel & Accessories > Clothing > Outerwear > Jackets",
  coat: "Apparel & Accessories > Clothing > Outerwear > Coats & Jackets",
  cardigan: "Apparel & Accessories > Clothing > Clothing Tops > Cardigans",
  turtleneck: "Apparel & Accessories > Clothing > Clothing Tops > Sweaters",
  zip_hoodie: "Apparel & Accessories > Clothing > Activewear > Activewear Sweatshirts & Hoodies > Hoodies",
  hoodie: "Apparel & Accessories > Clothing > Activewear > Activewear Sweatshirts & Hoodies > Hoodies",
  sweatshirt: "Apparel & Accessories > Clothing > Activewear > Activewear Sweatshirts & Hoodies > Sweatshirts",
  sweater: "Apparel & Accessories > Clothing > Clothing Tops > Sweaters",
  longsleeve: "Apparel & Accessories > Clothing > Clothing Tops > T-Shirts",
  polo: "Apparel & Accessories > Clothing > Clothing Tops > Polos",
  tshirt: "Apparel & Accessories > Clothing > Clothing Tops > T-Shirts",
  shirt: "Apparel & Accessories > Clothing > Clothing Tops > Shirts",
  bodysuit: "Apparel & Accessories > Clothing > Clothing Tops > Bodysuits",
  top: "Apparel & Accessories > Clothing > Clothing Tops",
  dress: "Apparel & Accessories > Clothing > Dresses",
  skirt: "Apparel & Accessories > Clothing > Skirts",
  suit: "Apparel & Accessories > Clothing > Suits",
  vest: "Apparel & Accessories > Clothing > Vests",
  underwear: "Apparel & Accessories > Clothing > Underwear & Socks > Underwear",
  other: "Apparel & Accessories",
};

export function getProductMapping(product: ParsedMarketplaceProduct) {
  const kind = detectProductKind(product);
  return {
    kind,
    productType: TYPE_UA[kind],
    nameType: NAME_TYPE_UA[kind],
    taxonomyPath: TAXONOMY_PATH[kind],
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cleanSupplierDescription(value: string | null | undefined) {
  const source = text(value);
  if (!source) return "";

  return source
    .replace(/\bShop\s+.+?\s+on\s+(?:MR PORTER|NET-A-PORTER)\b[.!]?/gi, "")
    .replace(/\bExplore the latest[^.!]*[.!]?/gi, "")
    .replace(/\bPromotion\s*:[\s\S]*$/gi, "")
    .replace(/\bT&Cs apply[.!]?/gi, "")
    .replace(/\bEnjoy\s+\d+%[^.!]*[.!]?/gi, "")
    .replace(/\bfirst order[^.!]*[.!]?/gi, "")
    .replace(/\bShop now[.!]?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDescriptionHtml(product: ParsedMarketplaceProduct) {
  const mapping = getProductMapping(product);
  const cleaned = cleanSupplierDescription(product.descriptionHtml || product.description);
  const title = text(product.title);
  const brand = text(product.brand);
  const lower = title.toLowerCase();
  const details: string[] = [];

  if (/leather|шкір/.test(lower)) details.push("виготовлений зі шкіри");
  if (/cotton|бавовн/.test(lower)) details.push("містить бавовну");
  if (/logo|логотип/.test(lower)) details.push("декорований фірмовим логотипом");
  if (/embroider|вишив/.test(lower)) details.push("оздоблений вишивкою");
  if (/straight[- ]leg|прямого крою/.test(lower)) details.push("має прямий крій");
  if (/oversized|оверсайз/.test(lower)) details.push("має вільний крій oversize");

  const fallback = `${mapping.nameType} ${brand}${details.length ? ` — ${details.join(", ")}` : ""}.`;
  const paragraphs = [cleaned || fallback];
  const rows: Array<[string, string]> = [
    ["Бренд", brand],
    ["Тип", mapping.nameType],
    ["Колір", text(product.color)],
    ["Склад", text(product.composition)],
    ["Код моделі", text(product.supplierProductId)],
  ].filter((row) => row[1]);

  const html = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`);
  if (rows.length) {
    html.push("<ul>");
    for (const [label, value] of rows) {
      html.push(`<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`);
    }
    html.push("</ul>");
  }
  return html.join("\n");
}
