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

type StonePayload = {
  url: string;
  plnRate?: number;
  quantity?: number;
};

function stoneIslandConfig(categoryId: string) {
  if (!categoryId.startsWith(STONE_PREFIX)) return null;

  let payload: StonePayload;
  try {
    payload = JSON.parse(decodeURIComponent(categoryId.slice(STONE_PREFIX.length))) as StonePayload;
    const parsed = new URL(payload.url);
    if (!/(^|\.)stoneisland\.com$/i.test(parsed.hostname)) return null;
    if (!/^https?:$/.test(parsed.protocol)) return null;
  } catch {
    return null;
  }

  const plnRate = Number(payload.plnRate || 12.19);
  const quantity = Math.max(0, Math.trunc(Number(payload.quantity ?? 5)));

  return {
    id: categoryId,
    source: "STONE_ISLAND",
    gender: "MEN",
    category: "Sale",
    baseUrl: payload.url,
    catalogUrl: payload.url,
    currency: "PLN",
    plnRate: Number.isFinite(plnRate) && plnRate > 0 ? plnRate : 12.19,
    defaultQuantity: quantity,
    brandFacet: "",
    priceFacet: "",
    brands: ["STONE ISLAND"],
    pages: 1,
    expected: 0,
    pageUrls: [payload.url],
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
