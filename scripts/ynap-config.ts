export type CrawlCategory = {
  id: string;
  source: "NET_A_PORTER" | "MR_PORTER";
  gender: "WOMEN" | "MEN";
  category: string;
  baseUrl: string;
  brandFacet: string;
  priceFacet: string;
  brands: string[];
  pages: number;
  expected: number;
};

export const crawlCategories: CrawlCategory[] = [
  { id: "nap-clothing", source: "NET_A_PORTER", gender: "WOMEN", category: "Clothing", baseUrl: "https://www.net-a-porter.com/en-pl/shop/clothing", brandFacet: "ads_f10003_ntk_cs", priceFacet: "price_EUR_4000000000000001121", brands: ["ACNE STUDIOS", "AMI PARIS", "BALENCIAGA", "BRUNELLO CUCINELLI", "JACQUEMUS", "JIL SANDER", "LORO PIANA", "ON", "THE ROW", "TOTEME"], pages: 7, expected: 700 },
  { id: "nap-shoes", source: "NET_A_PORTER", gender: "WOMEN", category: "Shoes", baseUrl: "https://www.net-a-porter.com/en-pl/shop/shoes", brandFacet: "ads_f10003_ntk_cs", priceFacet: "price_EUR_4000000000000001121", brands: ["ACNE STUDIOS", "BALENCIAGA", "BRUNELLO CUCINELLI", "GABRIELA HEARST", "JACQUEMUS", "JIL SANDER", "LORO PIANA", "ON", "SALOMON", "THE ROW", "TOTEME"], pages: 3, expected: 299 },
  { id: "nap-bags", source: "NET_A_PORTER", gender: "WOMEN", category: "Bags", baseUrl: "https://www.net-a-porter.com/en-pl/shop/bags", brandFacet: "ads_f10003_ntk_cs", priceFacet: "price_EUR_4000000000000001121", brands: ["ACNE STUDIOS", "BALENCIAGA", "JACQUEMUS", "JIL SANDER", "LORO PIANA", "ON", "THE ROW", "TOTEME"], pages: 2, expected: 146 },
  { id: "nap-accessories", source: "NET_A_PORTER", gender: "WOMEN", category: "Accessories", baseUrl: "https://www.net-a-porter.com/en-pl/shop/accessories", brandFacet: "ads_f10003_ntk_cs", priceFacet: "price_EUR_4000000000000001121", brands: ["ACNE STUDIOS", "BALENCIAGA", "BRUNELLO CUCINELLI", "JACQUEMUS", "JIL SANDER", "LORO PIANA", "THE ROW", "TOTEME"], pages: 3, expected: 137 },
  { id: "mrp-clothing", source: "MR_PORTER", gender: "MEN", category: "Clothing", baseUrl: "https://www.mrporter.com/en-pl/mens/clothing", brandFacet: "ads_f11001_ntk_cs", priceFacet: "price_EUR_4000000000000004449", brands: ["ACNE STUDIOS", "AMI PARIS", "BALENCIAGA", "BRUNELLO CUCINELLI", "CARHARTT WIP", "JACQUEMUS", "JIL SANDER", "LORO PIANA", "ON", "STONE ISLAND", "THE ROW"], pages: 10, expected: 910 },
  { id: "mrp-shoes", source: "MR_PORTER", gender: "MEN", category: "Shoes", baseUrl: "https://www.mrporter.com/en-pl/mens/shoes", brandFacet: "ads_f11001_ntk_cs", priceFacet: "price_EUR_4000000000000004449", brands: ["ACNE STUDIOS", "BALENCIAGA", "BRUNELLO CUCINELLI", "GOLDEN GOOSE", "LORO PIANA", "SALOMON", "THE ROW"], pages: 3, expected: 282 },
  { id: "mrp-bags", source: "MR_PORTER", gender: "MEN", category: "Bags", baseUrl: "https://www.mrporter.com/en-pl/mens/accessories/bags", brandFacet: "ads_f11001_ntk_cs", priceFacet: "price_EUR_4000000000000004449", brands: ["ACNE STUDIOS", "AMI PARIS", "BALENCIAGA", "BRUNELLO CUCINELLI", "LORO PIANA", "STONE ISLAND", "THE ROW"], pages: 1, expected: 37 },
  { id: "mrp-accessories", source: "MR_PORTER", gender: "MEN", category: "Accessories", baseUrl: "https://www.mrporter.com/en-pl/mens/accessories", brandFacet: "ads_f11001_ntk_cs", priceFacet: "price_EUR_4000000000000004449", brands: ["ACNE STUDIOS", "AMI PARIS", "BALENCIAGA", "BRUNELLO CUCINELLI", "JACQUEMUS", "STONE ISLAND", "THE ROW"], pages: 2, expected: 156 },
];

const priceRanges = [
  "%28%7B*+250%7D+250%29",
  "%28%7B250+500%7D+500%29",
  "%28%7B500+1000%7D+1000%29",
  "%28%7B1000+2000%7D+2000%29",
];

function encoded(value: string) {
  return encodeURIComponent(value).replace(/\*/g, "%2A");
}

export function categoryUrl(config: CrawlCategory, page = 1) {
  const facets = [
    ...config.brands.map((brand) => `${config.brandFacet}%3A%22${brand.replace(/ /g, "+")}%22`),
    ...priceRanges.map((range) => `${config.priceFacet}%3A${range}`),
  ];
  const query = facets.map((facet) => `facet=${encoded(facet)}`);
  if (page > 1) query.push(`pageNumber=${page}`);
  return `${config.baseUrl}?${query.join("&")}`;
}

export function selectCategories(value?: string) {
  if (!value || value === "all") return crawlCategories;
  const ids = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  return crawlCategories.filter((item) => ids.has(item.id));
}
