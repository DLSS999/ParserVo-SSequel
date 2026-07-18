import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { loadSupabaseCatalog } from "../services/supabase-catalog.server";
import {
  enqueueCrawlJob,
  listCrawlJobs,
  listParserVoAgents,
} from "../services/crawl-jobs.server";
import type { ParsedMarketplaceProduct } from "../services/media.server";

const STOCK_REFRESH_PREFIX = "stone-island-stock-refresh:";

function parsePositive(value: unknown, fallback: number) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseQuantity(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function stockSummary(product: ParsedMarketplaceProduct) {
  const variants = product.variants || [];
  const inStock = variants.filter((variant) => variant.available !== false && variant.quantity > 0);
  const totalQuantity = inStock.reduce((sum, variant) => sum + Number(variant.quantity || 0), 0);
  const sizes = inStock
    .map((variant) => variant.size)
    .filter((size) => !/^(default title|one size|os|un)$/i.test(String(size)))
    .join(", ");
  return {
    inStockVariants: inStock.length,
    totalQuantity,
    sizes: sizes || (inStock.length ? "Без размерной опции" : "Нет в наличии"),
  };
}

function legacyProductId(gid: string | null | undefined) {
  return String(gid || "").split("/").pop() || "";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [catalog, agents, jobs] = await Promise.all([
    loadSupabaseCatalog(),
    listParserVoAgents(session.shop).catch(() => []),
    listCrawlJobs(session.shop, 10).catch(() => []),
  ]);

  const products = catalog.products
    .filter((product) => product.source === "STONE_ISLAND")
    .map((product) => ({
      handle: String(product.handle || product.supplierProductId || product.sourceUrl),
      title: product.title,
      code: product.supplierProductId || "—",
      color: product.color || "—",
      type: product.productType || product.category || "—",
      sourceUrl: product.sourceUrl,
      shopifyProductGid: product.shopifyProductGid || null,
      importStatus: product.importStatus || "—",
      lastError: product.lastError || null,
      lastSeenAt: product.lastSeenAt || product.updatedAt || null,
      ...stockSummary(product),
    }))
    .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")));

  const imported = products.filter((product) => product.shopifyProductGid);
  const inStock = imported.filter((product) => product.totalQuantity > 0);
  const outOfStock = imported.filter((product) => product.totalQuantity === 0);
  const availableVariants = imported.reduce((sum, product) => sum + product.inStockVariants, 0);
  const lastSeenAt = imported
    .map((product) => product.lastSeenAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  const now = Date.now();
  const onlineAgent = agents.find((agent) => {
    const seen = new Date(agent.last_seen_at).getTime();
    return Number.isFinite(seen) && now - seen < 45000;
  }) || null;
  const activeJob = jobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING") || null;

  return json({
    shop: session.shop,
    products,
    catalogConnected: catalog.connected,
    catalogError: catalog.error,
    metrics: {
      stored: products.length,
      imported: imported.length,
      inStock: inStock.length,
      outOfStock: outOfStock.length,
      availableVariants,
      lastSeenAt,
    },
    onlineAgent,
    activeJob,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "refreshStock");

  try {
    if (intent !== "refreshStock") {
      return json({ ok: false, message: `Неизвестное действие: ${intent}.` });
    }

    const catalog = await loadSupabaseCatalog();
    const imported = catalog.products.filter((product) => (
      product.source === "STONE_ISLAND"
      && Boolean(product.shopifyProductGid)
      && /^https:\/\/(?:www\.)?stoneisland\.com\//i.test(product.sourceUrl)
    ));
    if (!imported.length) {
      return json({ ok: false, message: "Нет импортированных Stone Island товаров для обновления наличия." });
    }

    const plnRate = parsePositive(form.get("plnRate"), 12.19);
    const quantity = parseQuantity(form.get("quantity"), 5);
    const categoryId = `${STOCK_REFRESH_PREFIX}${encodeURIComponent(JSON.stringify({ plnRate, quantity }))}`;
    const job = await enqueueCrawlJob({
      shopDomain: session.shop,
      categoryId,
      maxProducts: imported.length,
    });

    return json({
      ok: true,
      message: `Обновление наличия поставлено в очередь для ${imported.length} товаров. Доступный размер получит ${quantity} шт., отсутствующий — 0.`,
      jobId: job.id,
    });
  } catch (error) {
    return json({
      ok: false,
      message: error instanceof Error ? error.message : "Не удалось запустить обновление наличия.",
    });
  }
}

export default function StoneIslandCatalog() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const active = Boolean(data.activeJob);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(timer);
  }, [active, revalidator]);

  return (
    <main className="pv-stack">
      <div className="pv-page-header">
        <div>
          <h1>STONE ISLAND / CATALOG</h1>
          <p>Полный список товаров, которые ParserVo сохранил и связал с Shopify.</p>
        </div>
        <div className="pv-header">
          <span className={`pv-pill ${data.catalogConnected ? "pv-pill-green" : "pv-pill-red"}`}>
            {data.catalogConnected ? `Supabase: ${data.metrics.stored}` : "Supabase error"}
          </span>
          <span className={`pv-pill ${data.onlineAgent ? "pv-pill-green" : "pv-pill-red"}`}>
            {data.onlineAgent ? `Chrome v${data.onlineAgent.version || "?"}` : "Chrome offline"}
          </span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>
          {actionData.message}
        </div>
      ) : null}
      {data.catalogError ? <div className="pv-alert pv-alert-error">Supabase: {data.catalogError}</div> : null}
      {data.activeJob ? (
        <div className="pv-alert pv-alert-success">
          Активное задание: {data.activeJob.message || data.activeJob.status}. Прогресс: {data.activeJob.products_done || 0}/{data.activeJob.products_total || 0}.
        </div>
      ) : null}

      <section className="pv-grid">
        <div className="pv-metric"><div className="pv-label">Сохранено ParserVo</div><div className="pv-value">{data.metrics.stored}</div></div>
        <div className="pv-metric"><div className="pv-label">Связано с Shopify</div><div className="pv-value">{data.metrics.imported}</div></div>
        <div className="pv-metric"><div className="pv-label">Товаров в наличии</div><div className="pv-value">{data.metrics.inStock}</div></div>
        <div className="pv-metric"><div className="pv-label">Доступных вариантов</div><div className="pv-value">{data.metrics.availableVariants}</div></div>
      </section>

      <section className="pv-card">
        <div className="pv-header">
          <div>
            <h2 className="pv-title">МАССОВОЕ ОБНОВЛЕНИЕ НАЛИЧИЯ</h2>
            <p className="pv-note">Открывает сохранённые ссылки Stone Island и меняет только остатки. Фото, название, описание и цены повторно не загружаются.</p>
          </div>
          <span className="pv-pill">Последняя проверка: {dateTime(data.metrics.lastSeenAt)}</span>
        </div>
        <Form method="post" className="pv-settings-grid">
          <input type="hidden" name="intent" value="refreshStock" />
          <label><span>PLN → UAH</span><input name="plnRate" type="number" min="0.01" step="0.01" defaultValue="12.19" /></label>
          <label><span>Остаток доступного размера</span><input name="quantity" type="number" min="0" step="1" defaultValue="5" /></label>
          <button className="pv-button pv-button-primary" type="submit" disabled={!data.onlineAgent || active || data.metrics.imported === 0}>
            ОБНОВИТЬ НАЛИЧИЕ ВСЕХ {data.metrics.imported} ТОВАРОВ
          </button>
        </Form>
      </section>

      <section className="pv-card">
        <div className="pv-header">
          <div>
            <h2 className="pv-title">ИМПОРТИРОВАННЫЕ ТОВАРЫ STONE ISLAND</h2>
            <p className="pv-note">Shopify выводит список страницами по 50 товаров. Здесь показаны все {data.products.length} сохранённых позиций.</p>
          </div>
          <button className="pv-button" type="button" onClick={() => revalidator.revalidate()}>ОБНОВИТЬ СПИСОК</button>
        </div>
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead>
              <tr>
                <th>Товар</th><th>Артикул</th><th>Цвет</th><th>Тип</th><th>Размеры в наличии</th><th>Остаток</th><th>Статус</th><th>Обновлено</th><th>Ссылки</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product) => {
                const shopifyId = legacyProductId(product.shopifyProductGid);
                return (
                  <tr key={product.handle}>
                    <td>{product.title}</td>
                    <td>{product.code}</td>
                    <td>{product.color}</td>
                    <td>{product.type}</td>
                    <td>{product.sizes}</td>
                    <td>{product.totalQuantity}</td>
                    <td>{product.shopifyProductGid ? product.importStatus : "Не выгружен"}</td>
                    <td>{dateTime(product.lastSeenAt)}</td>
                    <td>
                      <a href={product.sourceUrl} target="_blank" rel="noreferrer">Поставщик</a>
                      {shopifyId ? <> · <a href={`https://${data.shop}/admin/products/${shopifyId}`} target="_blank" rel="noreferrer">Shopify</a></> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
