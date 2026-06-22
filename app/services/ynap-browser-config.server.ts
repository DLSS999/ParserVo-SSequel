export {
  crawlCategories as browserCategories,
  categoryUrl as buildBrowserCategoryUrl,
  selectCategories,
} from "../../scripts/ynap-config";

import {
  crawlCategories,
  categoryUrl,
} from "../../scripts/ynap-config";

export function configsForJob(categoryId: string) {
  const selected = categoryId === "all"
    ? crawlCategories
    : crawlCategories.filter((category) => category.id === categoryId);

  return selected.map((category) => ({
    ...category,
    pageUrls: Array.from({ length: category.pages }, (_, index) => categoryUrl(category, index + 1)),
  }));
}
