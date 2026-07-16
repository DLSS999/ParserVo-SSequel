import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { calculatePricing, sortSizesForShopify } from "../services/pricing.server";
import { splitMedia, type ParsedMarketplaceProduct } from "../services/media.server";
import { getSampleParsedProducts } from "../services/sample-products.server";
import { loadSupabaseCatalog } from "../services/supabase-catalog.server";
import { setProductQuantity } from "../services/shopify-admin.server";
import { syncCatalogToShopify, syncProductToShopify } from "../services/shopify-sync.server";

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

function parsePositive(value: unknown, fallback: number) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseQuantity(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function money(value: number | null | undefined) {
  return value == null ? "—" : `${value.toLocaleString("uk-UA")} грн`;
}

function settingsFromRequest(request: Request) {
  const url = new URL(request.url);
  return {
    eurRate: parsePositive(url.searchParams.get("eur"), 45),
    plnRate: parsePositive(url.searchParams.get("pln"), 12.19),
    quantity: parseQuantity(url.searchParams.get("qty"), 5),
    autoSync: url.searchParams.get("autoSync") === "on",
  };
}

async function catalogProducts(appUrl: string) {
  const catalog = await loadSupabaseCatalog();
  const products = catalog.products.length ? catalog.products : getSampleParsedProducts(appUrl);
  return { ...catalog, products };
}

function productPricing(product: ParsedMarketplaceProduct, eurRate: number, plnRate: number) {
  const calculated = calculatePricing({
    supplierPrice: product.price || 0,
    supplierOldPrice: product.compareAtPrice || null,
    currency: product.currency,
    eurRate,
    plnRate,
    roundingRule: "round_to_5",
    compareAtEnabled: true,
  });
  const cost = product.pricing?.costPriceUah ?? calculated.costPriceUah;
  const sale = product.pricing?.salePriceUah ?? calculated.salePriceUah;
  const compareAt = product.pricing?.compareAtPriceUah ?? calculated.compareAtPriceUah;
  return { cost, sale, compareAt, profit: sale - cost, discount: compareAt && compareAt > sale ? compareAt - sale : null };
}

function matchesCategory(product: ParsedMarketplaceProduct, categoryId: string) {
  const isNet = categoryId.startsWith("nap-");
  if (isNet && product.source !== "NET_A_PORTER") return false;
  if (!isNet && product.source !== "MR_PORTER") return false;

  const group = categoryId.split("-")[1] || "";
  const text = [product.category, product.productType, product.productCategory, product.sourceUrl]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (group === "clothing") return /clothing|apparel|hood|shirt|t-shirt|sweat|jacket|coat|jean|trouser|dress|skirt|top/.test(text);
  if (group === "shoes") return /shoe|sneaker|boot|loafer|sandal|heel|mule|slipper/.test(text);
  if (group === "bags") return /bag|backpack|briefcase|luggage|clutch|tote/.test(text);
  if (group === "accessories") return /accessor|belt|hat|cap|scarf|sock|wallet|glove|sunglass/.test(text);
  return true;
}

function reportMessage(prefix: string, report: { total: number; success: number; failed: number; errors: Array<{ handle: string; message: string }> }) {
  const firstError = report.errors[0]?.message;
  return `${prefix}: всего ${report.total}, успешно ${report.success}, ошибок ${report.failed}${firstError ? `. Первая ошибка: ${firstError}` : ""}.`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const settings = settingsFromRequest(request);
  const configReady = Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET && process.env.SHOPIFY_APP_URL);
  let shop: string | null = null;

  if (configReady) {
    const auth = await authenticate.admin(request);
    shop = auth.session.shop;
  }

  const appUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const catalog = await catalogProducts(appUrl);
  const products = catalog.products.map((product) => {
    const media = splitMedia(product.media);
    const pricing = productPricing(product, settings.eurRate, settings.plnRate);
    const rawVariants = product.variants || [];
    const availableSizes = rawVariants.length
      ? rawVariants.filter((variant) => variant.available !== false && variant.quantity > 0).map((variant) => variant.size)
      : product.sizes;
    const mappedStock = rawVariants.length
      ? rawVariants.filter((variant) => variant.available !== false && variant.quantity > 0).map((variant) => `${variant.size}: ${variant.quantity === 1 ? 1 : 5}`).join(", ")
      : "по правилу 1/5";

    return {
      handle: product.handle || product.supplierProductId || product.sourceUrl,
      source: product.source === "NET_A_PORTER" ? "NET-A-PORTER / Women" : "MR PORTER / Men",
      brand: product.brand,
      title: product.title,
      category: product.productType || product.category,
      sizes: sortSizesForShopify(availableSizes).join(", "),
      mappedStock,
      media: `${media.images.length} фото / ${media.videos.length} видео`,
      supplier: `${product.currency} ${product.price ?? 0}`,
      cost: money(pricing.cost),
      sale: money(pricing.sale),
      compareAt: money(pricing.compareAt),
      profit: money(pricing.profit),
    };
  });

  return json({
    categories,
    products,
    settings,
    configReady,
    shop,
    supabaseConnected: catalog.connected,
    supabaseError: catalog.error,
    catalogCount: catalog.products.length,
    totals: {
      products: categories.reduce((sum, category) => sum + category.expectedResults, 0),
      pages: categories.reduce((sum, category) => sum + category.pages, 0),
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET || !process.env.SHOPIFY_APP_URL) {
    return json({ ok: false, message: "Не заполнены Shopify переменные в Vercel." });
  }

  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "syncAll");
  const settings = {
    eurRate: parsePositive(form.get("eurRate"), 45),
    plnRate: parsePositive(form.get("plnRate"), 12.19),
    defaultQuantity: parseQuantity(form.get("quantity"), 5),
  };

  try {
    const appUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
    const catalog = await catalogProducts(appUrl);

    if (intent === "upload") {
      const handle = String(form.get("productHandle") || "");
      const product = catalog.products.find((item) => (item.handle || item.supplierProductId || item.sourceUrl) === handle);
      if (!product) return json({ ok: false, message: "Товар не найден в Supabase." });
      const result = await syncProductToShopify(admin, product, settings);
      return json({
        ok: true,
        message: `Товар синхронизирован: ${result.title}. Размеров: ${result.variants}, фото: ${result.images}.`,
        createdProductLegacyId: result.productId.split("/").pop() || result.productId,
      });
    }

    if (intent === "syncAll") {
      const report = await syncCatalogToShopify(admin, catalog.products, settings);
      return json({ ok: report.failed === 0, message: reportMessage("Автосинхронизация каталога", report), syncReport: report });
    }

    if (intent === "parse") {
      const categoryId = String(form.get("categoryId") || "");
      const selected = catalog.products.filter((product) => matchesCategory(product, categoryId));
      if (!selected.length) {
        return json({ ok: false, message: `В Supabase пока нет товаров для ${categoryId}.` });
      }
      const report = await syncCatalogToShopify(admin, selected, settings);
      return json({ ok: report.failed === 0, message: reportMessage(`Категория ${categoryId}`, report), syncReport: report });
    }

    if (intent === "inventory") {
      const productId = String(form.get("productId") || "").trim();
      if (!productId) return json({ ok: false, message: "Укажи Shopify Product ID." });
      const result = await setProductQuantity(admin, productId, settings.defaultQuantity);
      return json({ ok: true, message: `Остаток обновлён: ${result.updatedVariants} вариантов по ${result.quantity} шт.` });
    }

    return json({ ok: false, message: `Неизвестное действие ${intent} для ${session.shop}.` });
  } catch (error) {
    return json({ ok: false, message: error instanceof Error ? error.message : "Неизвестная ошибка Shopify." });
  }
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [autoMessage, setAutoMessage] = useState("");

  useEffect(() => {
    if (!actionData?.createdProductLegacyId) return;
    window.localStorage.setItem("parservo-last-product-id", actionData.createdProductLegacyId);
  }, [actionData]);

  useEffect(() => {
    if (!data.settings.autoSync || !data.configReady) return;
    let cancelled = false;

    const syncAll = async () => {
      const body = new FormData();
      body.set("intent", "syncAll");
      body.set("eurRate", String(data.settings.eurRate));
      body.set("plnRate", String(data.settings.plnRate));
      body.set("quantity", String(data.settings.quantity));
      const response = await fetch(window.location.href, { method: "POST", body });
      const result = await response.json().catch(() => null);
      if (!cancelled && result?.message) setAutoMessage(result.message);
    };

    const firstRun = window.setTimeout(syncAll, 1500);
    const timer = window.setInterval(syncAll, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstRun);
      window.clearInterval(timer);
    };
  }, [data.settings.autoSync, data.settings.eurRate, data.settings.plnRate, data.settings.quantity, data.configReady]);

  return (
    <main className="pv-stack">
      <div className="pv-page-header">
        <div><h1>STONE ISLAND / CATALOG CONTROL</h1><p>{data.shop ? `Подключён магазин: ${data.shop}` : "Shopify API не подключён"}</p></div>
        <div className="pv-header">
          <span className={`pv-pill ${data.supabaseConnected ? "pv-pill-green" : "pv-pill-red"}`}>{data.supabaseConnected ? `Supabase: ${data.catalogCount}` : "Supabase fallback"}</span>
          <span className={`pv-pill ${data.configReady ? "pv-pill-green" : "pv-pill-red"}`}>{data.configReady ? "Shopify API connected" : "Setup required"}</span>
        </div>
      </div>

      {actionData?.message ? <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>{actionData.message}</div> : null}
      {autoMessage ? <div className="pv-alert pv-alert-success">{autoMessage}</div> : null}
      {data.supabaseError ? <div className="pv-alert pv-alert-error">Supabase: {data.supabaseError}</div> : null}

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">CATALOG SYNCHRONIZATION</h2><span className="pv-pill pv-pill-green">правило наличия 0 / 1 / 5</span></div>
        <p className="pv-note">0 у поставщика — размер не передаётся. Ровно 1 — Shopify получает 1. Больше 1 или просто «в наличии» — Shopify получает 5.</p>
        <div className="pv-actions">
          <Form method="post">
            <input type="hidden" name="intent" value="syncAll" />
            <input type="hidden" name="eurRate" value={data.settings.eurRate} />
            <input type="hidden" name="plnRate" value={data.settings.plnRate} />
            <input type="hidden" name="quantity" value={data.settings.quantity} />
            <button className="pv-button pv-button-primary" type="submit" disabled={!data.configReady}>SYNC FULL CATALOG</button>
          </Form>
        </div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">CURRENCY / AUTOMATION</h2><span className="pv-pill pv-pill-green">редактируется</span></div>
        <Form method="get" className="pv-settings-grid">
          <label><span>EUR → UAH</span><input name="eur" type="number" min="0.01" step="0.01" defaultValue={data.settings.eurRate} /></label>
          <label><span>PLN → UAH</span><input name="pln" type="number" min="0.01" step="0.01" defaultValue={data.settings.plnRate} /></label>
          <label><span>Резервное количество</span><input name="qty" type="number" min="0" step="1" defaultValue={data.settings.quantity} /></label>
          <label className="pv-checkbox"><input name="autoSync" type="checkbox" defaultChecked={data.settings.autoSync} /> <span>Автоматически синхронизировать весь каталог каждые 5 минут, пока приложение открыто</span></label>
          <button className="pv-button pv-button-primary" type="submit">SAVE SETTINGS</button>
        </Form>
      </section>

      <section className="pv-grid">
        <div className="pv-metric"><div className="pv-label">Ожидается товаров</div><div className="pv-value">{data.totals.products}</div></div>
        <div className="pv-metric"><div className="pv-label">Страниц</div><div className="pv-value">{data.totals.pages}</div></div>
        <div className="pv-metric"><div className="pv-label">Каталог Supabase</div><div className="pv-value">{data.catalogCount}</div></div>
        <div className="pv-metric"><div className="pv-label">Статус</div><div className="pv-value">{data.configReady ? "Готово" : "Нужны ключи"}</div></div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">SOURCE CATEGORIES</h2><span className="pv-pill">парсинг + автоматическая выгрузка</span></div>
        <div className="pv-table-wrap"><table className="pv-table">
          <thead><tr><th>Источник</th><th>Категория</th><th>Страницы</th><th>Товары</th><th>Действие</th></tr></thead>
          <tbody>{data.categories.map((category) => (
            <tr key={category.id}><td>{category.source}</td><td>{category.category}</td><td>{category.pages}</td><td>{category.expectedResults}</td><td>
              <Form method="post">
                <input type="hidden" name="intent" value="parse" /><input type="hidden" name="categoryId" value={category.id} />
                <input type="hidden" name="eurRate" value={data.settings.eurRate} /><input type="hidden" name="plnRate" value={data.settings.plnRate} /><input type="hidden" name="quantity" value={data.settings.quantity} />
                <button className="pv-button" type="submit" disabled={!data.configReady}>Запустить и выгрузить</button>
              </Form>
            </td></tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">SHOPIFY CATALOG</h2><span className="pv-pill pv-pill-green">upsert без дублей</span></div>
        <div className="pv-table-wrap"><table className="pv-table">
          <thead><tr><th>Бренд</th><th>Название</th><th>Себестоимость</th><th>Цена</th><th>Старая цена</th><th>Размеры</th><th>Остатки Shopify</th><th>Медиа</th><th></th></tr></thead>
          <tbody>{data.products.map((product) => (
            <tr key={product.handle}><td>{product.brand}</td><td>{product.title}</td><td>{product.cost}</td><td className="pv-money-sale">{product.sale}</td><td className="pv-money-old">{product.compareAt}</td><td>{product.sizes || "нет в наличии"}</td><td>{product.mappedStock || "—"}</td><td>{product.media}</td><td>
              <Form method="post">
                <input type="hidden" name="intent" value="upload" /><input type="hidden" name="productHandle" value={product.handle} />
                <input type="hidden" name="eurRate" value={data.settings.eurRate} /><input type="hidden" name="plnRate" value={data.settings.plnRate} /><input type="hidden" name="quantity" value={data.settings.quantity} />
                <button className="pv-button pv-button-primary" type="submit" disabled={!data.configReady || !product.sizes}>Синхронизировать</button>
              </Form>
            </td></tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">MANUAL INVENTORY CONTROL</h2><span className="pv-pill">Shopify inventory</span></div>
        <Form method="post" className="pv-settings-grid">
          <input type="hidden" name="intent" value="inventory" />
          <label><span>Shopify Product ID</span><input name="productId" placeholder="1234567890" /></label>
          <label><span>Количество на каждый размер</span><input name="quantity" type="number" min="0" step="1" defaultValue={data.settings.quantity} /></label>
          <input type="hidden" name="eurRate" value={data.settings.eurRate} /><input type="hidden" name="plnRate" value={data.settings.plnRate} />
          <button className="pv-button pv-button-primary" type="submit" disabled={!data.configReady}>UPDATE INVENTORY</button>
        </Form>
      </section>
    </main>
  );
}
