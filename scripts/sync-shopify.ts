import { createBackgroundAdminClient } from "../app/services/shopify-client-credentials.server";
import { loadSupabaseCatalog } from "../app/services/supabase-catalog.server";
import { syncCatalogToShopify } from "../app/services/shopify-sync.server";

function selectedProducts<T extends { source?: string; category?: string; productType?: string | null }>(products: T[]) {
  const category = String(process.env.CRAWL_CATEGORY || "all");
  if (!category || category === "all") return products;

  const [site, group] = category.split("-");
  return products.filter((product) => {
    if (site === "nap" && product.source !== "NET_A_PORTER") return false;
    if (site === "mrp" && product.source !== "MR_PORTER") return false;
    const text = `${product.category || ""} ${product.productType || ""}`.toLowerCase();
    if (group === "clothing") return /clothing|hood|shirt|jacket|coat|jean|trouser|dress|skirt|top|sweat/.test(text);
    if (group === "shoes") return /shoe|sneaker|boot|loafer|sandal|heel|mule|slipper/.test(text);
    if (group === "bags") return /bag|backpack|briefcase|luggage|clutch|tote/.test(text);
    if (group === "accessories") return /accessor|belt|hat|cap|scarf|sock|wallet|glove|sunglass/.test(text);
    return true;
  });
}

async function main() {
  const catalog = await loadSupabaseCatalog();
  if (!catalog.connected) throw new Error(catalog.error || "Supabase catalog unavailable");

  let products = selectedProducts(catalog.products);
  const maxProducts = Math.max(0, Number(process.env.MAX_SYNC_PRODUCTS || 0));
  if (maxProducts > 0) products = products.slice(0, maxProducts);

  if (!products.length) {
    console.log("No products selected for Shopify sync.");
    return;
  }

  const client = await createBackgroundAdminClient(process.env.SHOPIFY_SHOP_DOMAIN);
  console.log(`Syncing ${products.length} products to ${client.shop}`);

  const report = await syncCatalogToShopify(client.admin, products, {
    eurRate: Number(process.env.EUR_RATE || 45),
    plnRate: Number(process.env.PLN_RATE || 12.19),
    defaultQuantity: Number(process.env.DEFAULT_QUANTITY || 5),
  });

  console.log(JSON.stringify(report, null, 2));
  if (report.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
