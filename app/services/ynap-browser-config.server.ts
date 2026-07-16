export {
  crawlCategories as browserCategories,
  categoryUrl as buildBrowserCategoryUrl,
  selectCategories,
} from "../../scripts/ynap-config";

import {
  crawlCategories,
  categoryUrl,
} from "../../scripts/ynap-config";

const STONE_PREFIX = "stone-island:";

function stoneIslandConfig(categoryId: string) {
  if (!categoryId.startsWith(STONE_PREFIX)) return null;

  const encodedUrl = categoryId.slice(STONE_PREFIX.length);
  let catalogUrl: string;

  try {
    catalogUrl = decodeURIComponent(encodedUrl);
    const parsed = new URL(catalogUrl);
    if (!/(^|\.)stoneisland\.com$/i.test(parsed.hostname)) return null;
    if (!/^https?:$/.test(parsed.protocol)) return null;
  } catch {
    return null;
  }

  return {
    id: categoryId,
    source: "STONE_ISLAND",
    gender: "MEN",
    category: "Sale",
    baseUrl: catalogUrl,
    brandFacet: "",
    priceFacet: "",
    brands: ["STONE ISLAND"],
    pages: 1,
    expected: 0,
    pageUrls: [catalogUrl],
  };
}

export function configsForJob(categoryId: string) {
  const stone = stoneIslandConfig(categoryId);
  if (stone) return [stone];

  const selected = categoryId === "all"
    ? crawlCategories
    : crawlCategories.filter((category) => category.id === categoryId);

  return selected.map((category) => ({
    ...category,
    pageUrls: Array.from({ length: category.pages }, (_, index) => categoryUrl(category, index + 1)),
  }));
}
