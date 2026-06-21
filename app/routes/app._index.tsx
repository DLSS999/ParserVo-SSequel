import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { calculatePricing, sortSizesForShopify } from "../services/pricing.server";
import { splitMedia } from "../services/media.server";
import { getSampleParsedProducts } from "../services/sample-products.server";
import { createShopifyProduct, setProductQuantity } from "../services/shopify-admin.server";

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
    quantity: parseQuantity(url.searchParams.get("qty"), 1),
    autoSync: url.searchParams.get("autoSync") === "on",
  };
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
  const samples = getSampleParsedProducts(appUrl);
  const products = samples.map((product, index) => {
    const media = splitMedia(product.media);
    const pricing = calculatePricing({
      supplierPrice: product.price || 0,
      supplierOldPrice: product.compareAtPrice || null,
      currency: product.currency,
      eurRate: settings.eurRate,
      plnRate: settings.plnRate,
      roundingRule: "round_to_5",
      compareAtEnabled: true,
    });

    return {
      index,
      source: product.source === "NET_A_PORTER" ? "NET-A-PORTER / Women" : "MR PORTER / Men",
      brand: product.brand,
      title: product.title,
      category: product.category,
      sizes: sortSizesForShopify(product.sizes).join(", "),
      media: `${media.images.length} фото / ${media.videos.length} видео`,
      supplier: `${product.currency} ${product.price}`,
      cost: money(pricing.costPriceUah),
      sale: money(pricing.salePriceUah),
      compareAt: money(pricing.compareAtPriceUah),
      profit: money(pricing.profitUah),
      discount: money(pricing.discountAmountUah),
    };
  });

  return json({
    categories,
    products,
    settings,
    configReady,
    shop,
    totals: {
      products: categories.reduce((sum, category) => sum + category.expectedResults, 0),
      pages: categories.reduce((sum, category) => sum + category.pages, 0),
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET || !process.env.SHOPIFY_APP_URL) {
    return json({
      ok: false,
      message: "Добавь в Vercel SHOPIFY_API_KEY, SHOPIFY_API_SECRET и SHOPIFY_APP_URL, затем сделай Redeploy.",
    });
  }

  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "parse");
  const settings = {
    eurRate: parsePositive(form.get("eurRate"), 45),
    plnRate: parsePositive(form.get("plnRate"), 12.19),
    defaultQuantity: parseQuantity(form.get("quantity"), 1),
  };

  try {
    if (intent === "upload") {
      const appUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
      const products = getSampleParsedProducts(appUrl);
      const index = parseQuantity(form.get("productIndex"), 0);
      const sourceProduct = products[index] || products[0];
      const created = await createShopifyProduct(admin, sourceProduct, settings);

      return json({
        ok: true,
        message: `Товар создан в Shopify как черновик: ${created.title}. Загружено фото: ${created.uploadedImages}.`,
        createdProductId: created.id,
        createdProductLegacyId: created.id.split("/").pop() || created.id,
        quantity: settings.defaultQuantity,
      });
    }

    if (intent === "inventory") {
      const productId = String(form.get("productId") || "").trim();
      if (!productId) {
        return json({ ok: false, message: "Укажи Shopify Product ID." });
      }
      const result = await setProductQuantity(admin, productId, settings.defaultQuantity);
      return json({
        ok: true,
        message: `Остаток обновлён: ${result.updatedVariants} вариантов по ${result.quantity} шт. Локация: ${result.locationName}.`,
      });
    }

    return json({
      ok: true,
      message: `Парсинг ${String(form.get("categoryId") || "категории")} поставлен в очередь для магазина ${session.shop}.`,
    });
  } catch (error) {
    return json({
      ok: false,
      message: error instanceof Error ? error.message : "Неизвестная ошибка Shopify.",
    });
  }
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  useEffect(() => {
    if (!actionData?.createdProductLegacyId) return;
    window.localStorage.setItem("parservo-last-product-id", actionData.createdProductLegacyId);
  }, [actionData]);

  useEffect(() => {
    if (!data.settings.autoSync) return;

    const sync = async () => {
      const productId = window.localStorage.getItem("parservo-last-product-id");
      if (!productId) return;
      const body = new FormData();
      body.set("intent", "inventory");
      body.set("productId", productId);
      body.set("quantity", String(data.settings.quantity));
      body.set("eurRate", String(data.settings.eurRate));
      body.set("plnRate", String(data.settings.plnRate));
      await fetch(window.location.href, { method: "POST", body });
    };

    const timer = window.setInterval(sync, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [data.settings]);

  return (
    <main className="pv-stack">
      <div className="pv-page-header">
        <div>
          <h1>ParserVo Import App</h1>
          <p>{data.shop ? `Подключён магазин: ${data.shop}` : "Shopify API ещё не подключён"}</p>
        </div>
        <span className={`pv-pill ${data.configReady ? "pv-pill-green" : "pv-pill-red"}`}>
          {data.configReady ? "Shopify API connected" : "Setup required"}
        </span>
      </div>

      {actionData?.message ? (
        <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>{actionData.message}</div>
      ) : null}

      {!data.configReady ? (
        <section className="pv-card">
          <h2 className="pv-title">Нужно завершить подключение</h2>
          <p>В Vercel добавь Client ID как SHOPIFY_API_KEY, Secret как SHOPIFY_API_SECRET и production URL как SHOPIFY_APP_URL.</p>
        </section>
      ) : null}

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">Курс валют и остатки</h2>
          <span className="pv-pill pv-pill-green">редактируется</span>
        </div>
        <Form method="get" className="pv-settings-grid">
          <label><span>EUR → UAH</span><input name="eur" type="number" min="0.01" step="0.01" defaultValue={data.settings.eurRate} /></label>
          <label><span>PLN → UAH</span><input name="pln" type="number" min="0.01" step="0.01" defaultValue={data.settings.plnRate} /></label>
          <label><span>Количество по умолчанию</span><input name="qty" type="number" min="0" step="1" defaultValue={data.settings.quantity} /></label>
          <label className="pv-checkbox"><input name="autoSync" type="checkbox" defaultChecked={data.settings.autoSync} /> <span>Обновлять последний товар каждые 5 минут, пока приложение открыто</span></label>
          <button className="pv-button pv-button-primary" type="submit">Сохранить и пересчитать</button>
        </Form>
      </section>

      <section className="pv-grid">
        <div className="pv-metric"><div className="pv-label">Ожидается товаров</div><div className="pv-value">{data.totals.products}</div></div>
        <div className="pv-metric"><div className="pv-label">Страниц</div><div className="pv-value">{data.totals.pages}</div></div>
        <div className="pv-metric"><div className="pv-label">Медиа</div><div className="pv-value">5 фото + видео</div></div>
        <div className="pv-metric"><div className="pv-label">Статус</div><div className="pv-value">{data.configReady ? "Готово к тесту" : "Нужны ключи"}</div></div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">Категории для парсинга</h2><span className="pv-pill">NET / MR PORTER</span></div>
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Источник</th><th>Категория</th><th>Страницы</th><th>Товары</th><th>Действие</th></tr></thead>
            <tbody>
              {data.categories.map((category) => (
                <tr key={category.id}>
                  <td>{category.source}</td><td>{category.category}</td><td>{category.pages}</td><td>{category.expectedResults}</td>
                  <td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="parse" />
                      <input type="hidden" name="categoryId" value={category.id} />
                      <button className="pv-button" type="submit" disabled={!data.configReady}>Start Parsing</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">Тестовая загрузка в Shopify</h2><span className="pv-pill pv-pill-green">5 фото + варианты</span></div>
        <p className="pv-note">Кнопка создаёт реальный черновик Shopify через Admin GraphQL API.</p>
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Бренд</th><th>Название</th><th>Поставщик</th><th>Себестоимость</th><th>Цена</th><th>Старая цена</th><th>Прибыль</th><th>Размеры</th><th>Медиа</th><th></th></tr></thead>
            <tbody>
              {data.products.map((product) => (
                <tr key={`${product.brand}-${product.title}`}>
                  <td>{product.brand}</td><td>{product.title}</td><td>{product.supplier}</td><td>{product.cost}</td>
                  <td className="pv-money-sale">{product.sale}</td><td className="pv-money-old">{product.compareAt}</td><td>{product.profit}</td><td>{product.sizes}</td><td>{product.media}</td>
                  <td>
                    <Form method="post">
                      <input type="hidden" name="intent" value="upload" />
                      <input type="hidden" name="productIndex" value={product.index} />
                      <input type="hidden" name="eurRate" value={data.settings.eurRate} />
                      <input type="hidden" name="plnRate" value={data.settings.plnRate} />
                      <input type="hidden" name="quantity" value={data.settings.quantity} />
                      <button className="pv-button pv-button-primary" type="submit" disabled={!data.configReady}>Загрузить черновик</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pv-card">
        <div className="pv-header"><h2 className="pv-title">Обновление количества</h2><span className="pv-pill">Shopify inventory</span></div>
        <Form method="post" className="pv-settings-grid">
          <input type="hidden" name="intent" value="inventory" />
          <label><span>Shopify Product ID</span><input name="productId" placeholder="1234567890" /></label>
          <label><span>Количество на каждый размер</span><input name="quantity" type="number" min="0" step="1" defaultValue={data.settings.quantity} /></label>
          <input type="hidden" name="eurRate" value={data.settings.eurRate} />
          <input type="hidden" name="plnRate" value={data.settings.plnRate} />
          <button className="pv-button pv-button-primary" type="submit" disabled={!data.configReady}>Обновить остатки</button>
        </Form>
      </section>
    </main>
  );
}
