import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { calculatePricing, sortSizesForShopify } from "../services/pricing.server";
import { splitMedia } from "../services/media.server";
import { getSampleParsedProducts } from "../services/sample-products.server";

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

function uah(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${value.toLocaleString("uk-UA")} грн`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const products = getSampleParsedProducts().map((product) => {
    const media = splitMedia(product.media);
    const pricing = calculatePricing({ supplierPrice: product.price || 0, supplierOldPrice: product.compareAtPrice || null, currency: product.currency, eurRate: 45, plnRate: 12.19, roundingRule: "round_to_5", compareAtEnabled: true });
    return {
      source: product.source === "NET_A_PORTER" ? "NET-A-PORTER / Women" : "MR PORTER / Men",
      brand: product.brand,
      title: product.title,
      category: product.category,
      sizes: sortSizesForShopify(product.sizes).join(", "),
      media: `${media.images.length} фото / ${media.videos.length} видео`,
      supplier: `${product.currency} ${product.price}`,
      cost: uah(pricing.costPriceUah),
      sale: uah(pricing.salePriceUah),
      old: uah(pricing.compareAtPriceUah),
      profit: uah(pricing.profitUah),
      discount: uah(pricing.discountAmountUah),
    };
  });
  const totals = { products: categories.reduce((sum, c) => sum + c.expectedResults, 0), pages: categories.reduce((sum, c) => sum + c.pages, 0), media: "5 фото + видео", formula: "Old ParserVo" };
  return json({ categories, products, totals });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const categoryId = String(form.get("categoryId"));
  return json({ ok: true, message: `Запуск принят для ${categoryId}. Следующий этап: подключаем БД и реальный сбор 5 фото товара.` });
}

export default function AppIndex() {
  const { categories, products, totals } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <main className="pv-stack">
      <h1>ParserVo Import App</h1>
      {actionData?.message ? <div className="pv-card">{actionData.message}</div> : null}

      <section className="pv-grid">
        <div className="pv-metric"><div className="pv-label">Expected products</div><div className="pv-value">{totals.products}</div></div>
        <div className="pv-metric"><div className="pv-label">Pages</div><div className="pv-value">{totals.pages}</div></div>
        <div className="pv-metric"><div className="pv-label">Media per product</div><div className="pv-value">{totals.media}</div></div>
        <div className="pv-metric"><div className="pv-label">Pricing</div><div className="pv-value">{totals.formula}</div></div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">Marketplace import dashboard</h2><span className="pv-pill pv-pill-green">Ready</span></div>
        <p className="pv-note">NET-A-PORTER = Women. MR PORTER = Men.</p>
        <div className="pv-table-wrap"><table className="pv-table"><thead><tr><th>Source</th><th>Category</th><th>Pages</th><th>Expected</th><th>Status</th><th>Action</th></tr></thead><tbody>
          {categories.map((c) => <tr key={c.id}><td>{c.source}</td><td>{c.category}</td><td>{c.pages}</td><td>{c.expectedResults}</td><td><span className="pv-pill">READY</span></td><td><Form method="post"><input type="hidden" name="categoryId" value={c.id} /><button className="pv-button" type="submit">Start Parsing</button></Form></td></tr>)}
        </tbody></table></div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">Pricing preview</h2><span className="pv-pill pv-pill-green">5 photos supported</span></div>
        <p className="pv-note">Supplier = price from source. Cost = supplier x rate. Sale = cost + our profit + 5%. Compare-at = old crossed price.</p>
        <div className="pv-table-wrap"><table className="pv-table"><thead><tr><th>Source</th><th>Brand</th><th>Title</th><th>Supplier</th><th>Cost</th><th>Sale</th><th>Compare-at</th><th>Profit</th><th>Discount</th><th>Sizes</th><th>Media</th></tr></thead><tbody>
          {products.map((p) => <tr key={`${p.brand}-${p.title}`}><td>{p.source}</td><td>{p.brand}</td><td>{p.title}</td><td>{p.supplier}</td><td className="pv-money-cost">{p.cost}</td><td className="pv-money-sale">{p.sale}</td><td className="pv-money-old">{p.old}</td><td>{p.profit}</td><td>{p.discount}</td><td>{p.sizes}</td><td>{p.media}</td></tr>)}
        </tbody></table></div>
      </section>
    </main>
  );
}
