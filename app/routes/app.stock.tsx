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
    timeStyle: "medium",
  }).format(new Date(value));
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const [catalog, agents, jobs] = await Promise.all([
    loadSupabaseCatalog(),
    listParserVoAgents(session.shop).catch(() => []),
    listCrawlJobs(session.shop, 20).catch(() => []),
  ]);

  const supported = catalog.products.filter((product) => (
    product.source === "STONE_ISLAND"
    && Boolean(product.shopifyProductGid)
    && /^https:\/\/(?:www\.)?stoneisland\.com\//i.test(product.sourceUrl)
  ));
  const suppliers = Array.from(new Set(supported.map((product) => product.brand || product.source))).sort();
  const now = Date.now();
  const onlineAgent = agents.find((agent) => {
    const seen = new Date(agent.last_seen_at).getTime();
    return Number.isFinite(seen) && now - seen < 45000;
  }) || null;
  const activeJob = jobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING") || null;
  const lastRefresh = jobs.find((job) => String(job.category_id || "").startsWith(STOCK_REFRESH_PREFIX)) || null;

  return json({
    importedProducts: supported.length,
    suppliers,
    onlineAgent,
    activeJob,
    lastRefresh,
    catalogConnected: catalog.connected,
    catalogError: catalog.error,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    const catalog = await loadSupabaseCatalog();
    const imported = catalog.products.filter((product) => (
      product.source === "STONE_ISLAND"
      && Boolean(product.shopifyProductGid)
      && /^https:\/\/(?:www\.)?stoneisland\.com\//i.test(product.sourceUrl)
    ));
    if (!imported.length) {
      return json({ ok: false, message: "Нет импортированных товаров с подключённым обновлением наличия." });
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
      jobId: job.id,
      message: `Обновление наличия поставлено в очередь для ${imported.length} товаров. Новые товары создаваться не будут.`,
    });
  } catch (error) {
    return json({
      ok: false,
      message: error instanceof Error ? error.message : "Не удалось запустить обновление наличия.",
    });
  }
}

export default function StockPage() {
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
          <h1>SUPPLIERS / STOCK</h1>
          <p>Массовое обновление наличия всех ранее импортированных товаров подключённых поставщиков.</p>
        </div>
        <div className="pv-header">
          <span className={`pv-pill ${data.catalogConnected ? "pv-pill-green" : "pv-pill-red"}`}>
            {data.catalogConnected ? `${data.importedProducts} товаров` : "Supabase error"}
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
        <div className="pv-metric"><div className="pv-label">Товаров для проверки</div><div className="pv-value">{data.importedProducts}</div></div>
        <div className="pv-metric"><div className="pv-label">Подключённые поставщики</div><div className="pv-value">{data.suppliers.length}</div></div>
        <div className="pv-metric"><div className="pv-label">Поставщики</div><div className="pv-value">{data.suppliers.join(", ") || "—"}</div></div>
        <div className="pv-metric"><div className="pv-label">Последний запуск</div><div className="pv-value">{dateTime(data.lastRefresh?.requested_at)}</div></div>
      </section>

      <section className="pv-card">
        <div className="pv-header">
          <div>
            <h2 className="pv-title">ОБНОВИТЬ НАЛИЧИЕ ВСЕХ ТОВАРОВ ПОСТАВЩИКОВ</h2>
            <p className="pv-note">ParserVo откроет сохранённые ссылки и синхронизирует варианты. Новые товары не создаются, описание и фотографии не перезаписываются.</p>
          </div>
        </div>
        <Form method="post" className="pv-settings-grid">
          <label><span>PLN → UAH</span><input name="plnRate" type="number" min="0.01" step="0.01" defaultValue="12.19" /></label>
          <label><span>Остаток доступного размера</span><input name="quantity" type="number" min="0" step="1" defaultValue="5" /></label>
          <button className="pv-button pv-button-primary" type="submit" disabled={!data.onlineAgent || active || data.importedProducts === 0}>
            ОБНОВИТЬ НАЛИЧИЕ ВСЕХ {data.importedProducts} ТОВАРОВ
          </button>
        </Form>
      </section>
    </main>
  );
}
