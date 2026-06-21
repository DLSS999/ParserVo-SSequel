import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { calculatePricing, sortSizesForShopify } from "../services/pricing.server";
import { splitMedia } from "../services/media.server";
import { getSampleParsedProducts } from "../services/sample-products.server";
import { importParsedProductToShopify, updateProductInventory } from "../services/shopify-rest.server";

const categories = [
  { id: "nap-clothing", source: "NET-A-PORTER / Women", category: "Clothing", pages: 7, expectedResults: 700 },
  { id: "nap-shoes", source: "NET-A-PORTER / Women", category: "Shoes", pages: 3, expectedResults: 299 },
  { id: "nap-bags", source: "NET-A-PORTER / Women", category: "Bags", pages: 2, expectedResults: 146 },
  { id: "nap-accessories", source: "NET-A-PORTER / Women", category: "Accessories", pages: 3, expectedResults: 137 },
  { id: "mrp-clothing", source: "MR PORTER / Men", category: "Clothing", pages: 10, expectedResults: 910 },
  { id: "mrp-shoes", source: "MR PORTER / Men", category: "Shoes", pages: 3, expectedResults: 282 },
  { id: "mrp-bags", source: "MR PORTER / Men", category: "Bags", pages: 1, expectedResults: 37 },
  { id: "mrp-accessories", source: "MR PORTER / Men", category: "Accessories", pages: 2, expectedResults: 156 },
];

function num(value: unknown, fallback: number) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function uah(value: number | null | undefined) { return value == null ? "-" : `${value.toLocaleString("uk-UA")} UAH`; }
function settingsFromRequest(request: Request) {
  const url = new URL(request.url);
  return { eurRate: num(url.searchParams.get("eur"), 45), plnRate: num(url.searchParams.get("pln"), 12.19), qty: num(url.searchParams.get("qty"), 1), autoSync: url.searchParams.get("autoSync") === "on" };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const settings = settingsFromRequest(request);
  const products = getSampleParsedProducts().map((product, index) => {
    const media = splitMedia(product.media);
    const pricing = calculatePricing({ supplierPrice: product.price || 0, supplierOldPrice: product.compareAtPrice || null, currency: product.currency, eurRate: settings.eurRate, plnRate: settings.plnRate, roundingRule: "round_to_5", compareAtEnabled: true });
    return { index, source: product.source === "NET_A_PORTER" ? "NET-A-PORTER / Women" : "MR PORTER / Men", brand: product.brand, title: product.title, category: product.category, sizes: sortSizesForShopify(product.sizes).join(", "), media: `${media.images.length} photos / ${media.videos.length} videos`, supplier: `${product.currency} ${product.price}`, cost: uah(pricing.costPriceUah), sale: uah(pricing.salePriceUah), old: uah(pricing.compareAtPriceUah), profit: uah(pricing.profitUah), discount: uah(pricing.discountAmountUah) };
  });
  const totals = { products: categories.reduce((sum, c) => sum + c.expectedResults, 0), pages: categories.reduce((sum, c) => sum + c.pages, 0), media: "5 photos + video", formula: "Old ParserVo" };
  return json({ categories, products, totals, settings });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const actionType = String(form.get("actionType") || "start");
  const settings = { eurRate: num(form.get("eurRate"), 45), plnRate: num(form.get("plnRate"), 12.19), defaultQuantity: num(form.get("qty"), 1) };
  try {
    if (actionType === "import") {
      const product = getSampleParsedProducts()[num(form.get("productIndex"), 0)] || getSampleParsedProducts()[0];
      const created = await importParsedProductToShopify(product, settings);
      return json({ ok: true, message: `Product uploaded as draft. ID: ${created?.id || "unknown"}` });
    }
    if (actionType === "syncInventory") {
      const productId = String(form.get("shopifyProductId") || "").trim();
      if (!productId) return json({ ok: false, message: "Enter Shopify Product ID." });
      const result = await updateProductInventory(productId, settings.defaultQuantity);
      return json({ ok: true, message: `Inventory updated: ${result.updatedVariants} variants = ${result.quantity}.` });
    }
    return json({ ok: true, message: "Parsing action accepted. Database connection is next." });
  } catch (error) {
    return json({ ok: false, message: error instanceof Error ? error.message : "Unknown error" });
  }
}

export default function AppIndex() {
  const { categories, products, totals, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <main className="pv-stack">
      <h1>ParserVo Import App</h1>
      {actionData?.message ? <div className="pv-card">{actionData.message}</div> : null}
      <section className="pv-card"><div className="pv-header"><h2 className="pv-title">Currency and stock settings</h2><span className="pv-pill pv-pill-green">editable</span></div><Form method="get" className="pv-grid"><label className="pv-metric"><div className="pv-label">EUR rate</div><input name="eur" defaultValue={settings.eurRate} /></label><label className="pv-metric"><div className="pv-label">PLN rate</div><input name="pln" defaultValue={settings.plnRate} /></label><label className="pv-metric"><div className="pv-label">Default quantity</div><input name="qty" defaultValue={settings.qty} /></label><label className="pv-metric"><div className="pv-label">Auto update stock</div><input type="checkbox" name="autoSync" defaultChecked={settings.autoSync} /> enabled</label><button className="pv-button" type="submit">Recalculate</button></Form><p className="pv-note">Before real upload add Vercel ENV: SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN.</p></section>
      <section className="pv-grid"><div className="pv-metric"><div className="pv-label">Expected products</div><div className="pv-value">{totals.products}</div></div><div className="pv-metric"><div className="pv-label">Pages</div><div className="pv-value">{totals.pages}</div></div><div className="pv-metric"><div className="pv-label">Media per product</div><div className="pv-value">{totals.media}</div></div><div className="pv-metric"><div className="pv-label">Pricing</div><div className="pv-value">{totals.formula}</div></div></section>
      <section className="pv-card"><div className="pv-header"><h2 className="pv-title">Marketplace import dashboard</h2><span className="pv-pill pv-pill-green">Ready</span></div><div className="pv-table-wrap"><table className="pv-table"><thead><tr><th>Source</th><th>Category</th><th>Pages</th><th>Expected</th><th>Status</th><th>Action</th></tr></thead><tbody>{categories.map((c) => <tr key={c.id}><td>{c.source}</td><td>{c.category}</td><td>{c.pages}</td><td>{c.expectedResults}</td><td><span className="pv-pill">READY</span></td><td><Form method="post"><input type="hidden" name="actionType" value="start" /><input type="hidden" name="categoryId" value={c.id} /><button className="pv-button" type="submit">Start Parsing</button></Form></td></tr>)}</tbody></table></div></section>
      <section className="pv-card"><div className="pv-header"><h2 className="pv-title">Pricing preview and Shopify upload</h2><span className="pv-pill pv-pill-green">5 photos supported</span></div><div className="pv-table-wrap"><table className="pv-table"><thead><tr><th>Brand</th><th>Title</th><th>Supplier</th><th>Cost</th><th>Sale</th><th>Compare-at</th><th>Profit</th><th>Discount</th><th>Media</th><th>Upload</th></tr></thead><tbody>{products.map((p) => <tr key={`${p.brand}-${p.title}`}><td>{p.brand}</td><td>{p.title}</td><td>{p.supplier}</td><td className="pv-money-cost">{p.cost}</td><td className="pv-money-sale">{p.sale}</td><td className="pv-money-old">{p.old}</td><td>{p.profit}</td><td>{p.discount}</td><td>{p.media}</td><td><Form method="post"><input type="hidden" name="actionType" value="import" /><input type="hidden" name="productIndex" value={p.index} /><input type="hidden" name="eurRate" value={settings.eurRate} /><input type="hidden" name="plnRate" value={settings.plnRate} /><input type="hidden" name="qty" value={settings.qty} /><button className="pv-button" type="submit">Upload draft</button></Form></td></tr>)}</tbody></table></div></section>
      <section className="pv-card"><div className="pv-header"><h2 className="pv-title">Inventory update</h2><span className="pv-pill">manual now</span></div><Form method="post" className="pv-grid"><input type="hidden" name="actionType" value="syncInventory" /><label className="pv-metric"><div className="pv-label">Shopify Product ID</div><input name="shopifyProductId" placeholder="1234567890" /></label><label className="pv-metric"><div className="pv-label">Quantity</div><input name="qty" defaultValue={settings.qty} /></label><input type="hidden" name="eurRate" value={settings.eurRate} /><input type="hidden" name="plnRate" value={settings.plnRate} /><button className="pv-button" type="submit">Update quantity</button></Form></section>
    </main>
  );
}
