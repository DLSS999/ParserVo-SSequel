type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type TaxonomyCategoryNode = {
  id: string;
  fullName?: string | null;
  name?: string | null;
  isLeaf?: boolean | null;
};

export type ImportedProductForCategory = {
  title?: string | null;
  originalTitle?: string | null;
  category?: string | null;
  categoryUa?: string | null;
  productType?: string | null;
  breadcrumbs?: string | null;
  supplierUrl?: string | null;
};

const SHOPIFY_CATEGORY_PATHS = {
  T_SHIRTS: "Apparel & Accessories > Clothing > Clothing Tops > T-Shirts",
  POLOS: "Apparel & Accessories > Clothing > Clothing Tops > Polos",
  SHIRTS: "Apparel & Accessories > Clothing > Clothing Tops > Shirts",
  HOODIES: "Apparel & Accessories > Clothing > Clothing Tops > Hoodies",
  SWEATSHIRTS: "Apparel & Accessories > Clothing > Clothing Tops > Sweatshirts",
  SWEATERS: "Apparel & Accessories > Clothing > Clothing Tops > Sweaters",
  JACKETS: "Apparel & Accessories > Clothing > Outerwear > Jackets",
  COATS: "Apparel & Accessories > Clothing > Outerwear > Coats & Jackets",
  DRESSES: "Apparel & Accessories > Clothing > Dresses",
  JEANS: "Apparel & Accessories > Clothing > Pants > Jeans",
  TROUSERS: "Apparel & Accessories > Clothing > Pants > Trousers",
  SHORTS: "Apparel & Accessories > Clothing > Shorts",
  SKIRTS: "Apparel & Accessories > Clothing > Skirts",
  SUITS: "Apparel & Accessories > Clothing > Suits",
  VESTS: "Apparel & Accessories > Clothing > Vests",
  SNEAKERS: "Apparel & Accessories > Shoes > Sneakers",
  BOOTS: "Apparel & Accessories > Shoes > Boots",
  ANKLE_BOOTS: "Apparel & Accessories > Shoes > Boots",
  SANDALS: "Apparel & Accessories > Shoes > Sandals",
  LOAFERS: "Apparel & Accessories > Shoes > Loafers",
  HEELS: "Apparel & Accessories > Shoes > Pumps",
  FLIP_FLOPS: "Apparel & Accessories > Shoes > Flip Flops",
  HANDBAGS: "Apparel & Accessories > Handbags, Wallets & Cases > Handbags",
  BACKPACKS: "Apparel & Accessories > Handbags, Wallets & Cases > Backpacks",
  WALLETS: "Apparel & Accessories > Handbags, Wallets & Cases > Wallets & Money Clips",
  SUNGLASSES: "Apparel & Accessories > Clothing Accessories > Sunglasses",
  BELTS: "Apparel & Accessories > Clothing Accessories > Belts",
  SCARVES: "Apparel & Accessories > Clothing Accessories > Scarves & Shawls",
  HATS: "Apparel & Accessories > Clothing Accessories > Hats",
  JEWELRY: "Apparel & Accessories > Jewelry",
  WATCHES: "Apparel & Accessories > Jewelry > Watches",
} as const;

function normalize(value: string | null | undefined) {
  return String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function sourceText(product: ImportedProductForCategory) {
  return normalize([
    product.originalTitle,
    product.title,
    product.category,
    product.categoryUa,
    product.productType,
    product.breadcrumbs,
    product.supplierUrl,
  ].filter(Boolean).join(" "));
}

export function detectShopifyCategoryPath(product: ImportedProductForCategory) {
  const titleText = normalize([product.originalTitle, product.title].filter(Boolean).join(" "));
  const text = sourceText(product);

  const chooseFromText = (source: string) => {
    // Shoes first: prevents "shirt" from accidentally matching text elsewhere.
    if (/\b(lunarove|sneakers?|trainers?|sports shoes?|кросівк)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.SNEAKERS;
    if (/\b(ankle boots?|ботильйон)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.ANKLE_BOOTS;
    if (/\b(boots?|черевик)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.BOOTS;
    if (/\b(sandals?|сандал)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.SANDALS;
    if (/\b(loafers?|лофер)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.LOAFERS;
    if (/\b(pumps?|heeled shoes?|heels?|туфл)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.HEELS;
    if (/\b(flip flops?|slides?|slippers?|шльопанц)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.FLIP_FLOPS;

    // Clothing tops. Sweatshirt/sweater must be before T-shirt in fallback mode,
    // because old imported rows can contain stale category = T-shirt.
    if (/\b(hoodie|худі)\b/i.test(source)) return SHOPIFY_CATEGORY_PATHS.HOODIES;
    if (/\b(sweatshirt|світшот)\b/i.test(source)) return SHOPIFY_CATEGORY_PATHS.SWEATSHIRTS;
    if (/\b(sweater|pullover|knitwear|светр)\b/i.test(source)) return SHOPIFY_CATEGORY_PATHS.SWEATERS;
    if (/\b(polo|поло)\b/i.test(source)) return SHOPIFY_CATEGORY_PATHS.POLOS;
    if (/\b(t\s?shirt|tee\b|long sleeve|long-sleeve|футболк)/i.test(source)) return SHOPIFY_CATEGORY_PATHS.T_SHIRTS;
    if (/\b(shirt|сорочк)\b/i.test(source)) return SHOPIFY_CATEGORY_PATHS.SHIRTS;

    return "";
  };

  const titleCategory = chooseFromText(titleText);
  if (titleCategory) return titleCategory;
  const topOrShoeCategory = chooseFromText(text);
  if (topOrShoeCategory) return topOrShoeCategory;
  // Clothing.
  if (/\b(jacket|куртк)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.JACKETS;
  if (/\b(coat|пальт)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.COATS;
  if (/\b(dress|сукн)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.DRESSES;
  if (/\b(jeans|джинс)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.JEANS;
  if (/\b(trousers?|pants|штани)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.TROUSERS;
  if (/\b(shorts?|шорти)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.SHORTS;
  if (/\b(skirts?|спідниц)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.SKIRTS;
  if (/\b(suits?|костюм)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.SUITS;
  if (/\b(vests?|жилет)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.VESTS;

  // Accessories.
  if (/\b(handbags?|bags?|сумк)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.HANDBAGS;
  if (/\b(backpacks?|рюкзак)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.BACKPACKS;
  if (/\b(wallets?|гаманц)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.WALLETS;
  if (/\b(sunglasses?|сонцезахисні окуляри|окуляр)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.SUNGLASSES;
  if (/\b(belts?|ремен)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.BELTS;
  if (/\b(scarves?|shawls?|шарф|хустк)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.SCARVES;
  if (/\b(hats?|caps?|шапк|кепк)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.HATS;
  if (/\b(watches?|годинник)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.WATCHES;
  if (/\b(jewelry|jewellery|bracelet|earrings?|necklace|ring|браслет|сережк|каблучк|намисто)\b/i.test(text)) return SHOPIFY_CATEGORY_PATHS.JEWELRY;

  return SHOPIFY_CATEGORY_PATHS.T_SHIRTS;
}

async function shopifyGraphql<T>(admin: AdminClient, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();

  if (!response.ok) throw new Error(`Shopify API HTTP ${response.status}`);
  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message?: string }) => error.message || "Unknown GraphQL error").join(" | "));
  }

  return json.data as T;
}

function lastCategoryName(fullName: string) {
  return fullName.split(">").map((part) => part.trim()).filter(Boolean).pop() || fullName;
}

export async function resolveShopifyTaxonomyCategory(admin: AdminClient, product: ImportedProductForCategory) {
  const fullName = detectShopifyCategoryPath(product);
  const search = lastCategoryName(fullName);

  try {
    const data = await shopifyGraphql<{
      taxonomy: {
        categories: {
          nodes: TaxonomyCategoryNode[];
        };
      };
    }>(
      admin,
      `#graphql
      query ParserVoTaxonomyCategory($search: String!) {
        taxonomy {
          categories(first: 50, search: $search) {
            nodes {
              id
              name
              fullName
              isLeaf
            }
          }
        }
      }`,
      { search },
    );

    const nodes = data.taxonomy.categories.nodes || [];
    const exact = nodes.find((node) => normalize(node.fullName) === normalize(fullName));
    const byLeaf = nodes.find((node) => normalize(node.name) === normalize(search) && node.isLeaf !== false);
    const any = exact || byLeaf || nodes[0];

    return {
      id: any?.id || null,
      fullName,
      matchedFullName: any?.fullName || null,
    };
  } catch (error) {
    return {
      id: null,
      fullName,
      matchedFullName: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
