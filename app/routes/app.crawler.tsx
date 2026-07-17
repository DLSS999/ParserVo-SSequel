import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { browserCaptureKey } from "../services/browser-capture.server";
import {
  cancelCrawlJob,
  enqueueCrawlJob,
  listCrawlJobs,
  listParserVoAgents,
} from "../services/crawl-jobs.server";

const DEFAULT_STONE_URL = "https://www.stoneisland.com/en-pl/men/sales/view-all-sales";

function dateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "COMPLETED") return "pv-pill-green";
  if (status === "ERROR" || status === "CANCELLED") return "pv-pill-red";
  return "";
}

function progress(done?: number | null, total?: number | null) {
  const safeDone = Number(done || 0);
  const safeTotal = Number(total || 0);
  return safeTotal > 0 ? `${safeDone} / ${safeTotal}` : String(safeDone);
}

function parsePositive(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseQuantity(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function validateStoneUrl(value: string) {
  const parsed = new URL(value);
  if (!/(^|\.)stoneisland\.com$/i.test(parsed.hostname)) {
    throw new Error("Разрешены только ссылки сайта stoneisland.com.");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Ссылка должна начинаться с https://");
  }
  return parsed.toString();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  let jobs = [];
  let agents = [];
  let queueReady = true;
  let queueError: string | null = null;

  try {
    [jobs, agents] = await Promise.all([
      listCrawlJobs(session.shop, 30),
      listParserVoAgents(session.shop),
    ]);
  } catch (error) {
    queueReady = false;
    queueError = error instanceof Error ? error.message : "Queue error";
  }

  const now = Date.now();
  const onlineAgent = agents.find((agent) => {
    const lastSeen = new Date(agent.last_seen_at).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen < 45000;
  }) || null;

  return json({
    shop: session.shop,
    apiBaseUrl: process.env.SHOPIFY_APP_URL || new URL(request.url).origin,
    captureToken: browserCaptureKey(session.shop),
    jobs,
    onlineAgent,
    queueReady,
    queueError,
    defaultStoneUrl: DEFAULT_STONE_URL,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "enqueue");

  try {
    if (intent === "cancel") {
      const jobId = String(form.get("jobId") || "");
      if (!jobId) return json({ ok: false, message: "Job ID отсутствует." });
      await cancelCrawlJob(jobId, session.shop);
      return json({ ok: true, message: "Задание отменено." });
    }

    const catalogUrl = validateStoneUrl(String(form.get("catalogUrl") || "").trim());
    const maxProducts = parseQuantity(form.get("maxProducts"), 5);
    const plnRate = parsePositive(form.get("plnRate"), 12.19);
    const quantity = parseQuantity(form.get("quantity"), 5);
    const itemsPerLoad = Math.max(1, Math.min(200, parseQuantity(form.get("itemsPerLoad"), 16)));
    const encodedPayload = encodeURIComponent(JSON.stringify({
      url: catalogUrl,
      plnRate,
      quantity,
      itemsPerLoad,
    }));

    const job = await enqueueCrawlJob({
      shopDomain: session.shop,
      categoryId: `stone-island:${encodedPayload}`,
      maxProducts,
    });

    const estimatedClicks = maxProducts > 0
      ? Math.max(0, Math.ceil(maxProducts / itemsPerLoad) - 1)
      : null;

    return json({
      ok: true,
      message: `Stone Island добавлен в очередь. Лимит: ${maxProducts || "все товары"}. Партия: ${itemsPerLoad}.${estimatedClicks === null ? "" : ` Минимум LOAD MORE: ${estimatedClicks}.`}`,
      jobId: job.id,
    });
  } catch (error) {
    return json({ ok: false, message: error instanceof Error ? error.message : "Unknown queue error" });
  }
}

export default function CrawlerPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const active = data.jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING");

  useEffect(() => {
    const timer = window.setInterval(() => revalidator.revalidate(), active ? 5000 : 15000);
    return () => window.clearInterval(timer);
  }, [active, revalidator]);

  const extensionOnline = Boolean(data.onlineAgent);

  return (
    <main className="pv-stack">
      <div className="pv-page-header">
        <div>
          <h1>STONE ISLAND / IMPORT CONTROL</h1>
          <p>Вставьте ссылку каталога, задайте параметры и запустите импорт.</p>
        </div>
        <div className="pv-header">
          <span className={`pv-pill ${data.queueReady ? "pv-pill-green" : "pv-pill-red"}`}>
            {data.queueReady ? "Очередь подключена" : "Очередь не настроена"}
          </span>
          <span className={`pv-pill ${extensionOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {extensionOnline ? "Chrome Capture онлайн" : "Chrome Capture офлайн"}
          </span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>{actionData.message}</div>
      ) : null}
      {data.queueError ? <div className="pv-alert pv-alert-error">{data.queueError}</div> : null}

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">1. ВСТАВЬТЕ ССЫЛКУ STONE ISLAND</h2>
          <span className="pv-pill">Польская версия / PLN</span>
        </div>

        <Form method="post" className="pv-stack">
          <input type="hidden" name="intent" value="enqueue" />

          <label>
            <span>Ссылка на каталог или категорию</span>
            <input
              name="catalogUrl"
              type="url"
              required
              defaultValue={data.defaultStoneUrl}
              placeholder="https://www.stoneisland.com/en-pl/men/sales/view-all-sales"
            />
          </label>

          <div className="pv-settings-grid">
            <label>
              <span>Курс PLN → UAH</span>
              <input name="plnRate" inputMode="decimal" defaultValue="12,19" required />
            </label>
            <label>
              <span>Остаток каждого размера</span>
              <input name="quantity" type="number" min="0" step="1" defaultValue="5" required />
            </label>
            <label>
              <span>Лимит товаров для запуска</span>
              <input name="maxProducts" type="number" min="0" step="1" defaultValue="5" title="0 = все товары" />
            </label>
            <label>
              <span>Товаров за одно LOAD MORE</span>
              <input name="itemsPerLoad" type="number" min="1" max="200" step="1" defaultValue="16" required />
            </label>
          </div>

          <div className="pv-note">
            Stone Island обычно добавляет товары партиями. Для 544 товаров и партии 16 расширение выполнит минимум 33 нажатия LOAD MORE. Фактический рост ссылок всё равно проверяется после каждого нажатия.
          </div>

          <button className="pv-button pv-button-primary" type="submit" disabled={!data.queueReady || !extensionOnline}>
            НАЙТИ ТОВАРЫ И ИМПОРТИРОВАТЬ
          </button>
        </Form>
      </section>

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">2. ПОДКЛЮЧЕНИЕ CHROME CAPTURE</h2>
          <span className={`pv-pill ${extensionOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {extensionOnline ? data.onlineAgent?.message || "Расширение готово" : "нужно подключить расширение"}
          </span>
        </div>
        <div className="pv-settings-grid">
          <label><span>API Base URL</span><input readOnly value={data.apiBaseUrl} /></label>
          <label><span>Shop</span><input readOnly value={data.shop} /></label>
          <label><span>Browser capture token</span><input readOnly value={data.captureToken} /></label>
          <div className="pv-metric">
            <div className="pv-label">Последний heartbeat</div>
            <div className="pv-value">{data.onlineAgent ? dateTime(data.onlineAgent.last_seen_at) : "нет"}</div>
          </div>
        </div>
      </section>

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">3. ПРОГРЕСС И РЕЗУЛЬТАТ</h2>
          <button className="pv-button" type="button" onClick={() => revalidator.revalidate()}>ОБНОВИТЬ</button>
        </div>
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Время</th><th>Статус</th><th>Страницы</th><th>Ссылки</th><th>Товары</th><th>Ошибки</th><th>Сообщение</th><th></th></tr></thead>
            <tbody>
              {data.jobs.length ? data.jobs.map((job) => (
                <tr key={job.id}>
                  <td>{dateTime(job.requested_at)}</td>
                  <td><span className={`pv-pill ${statusClass(job.status)}`}>{job.status}</span></td>
                  <td>{progress(job.pages_done, job.pages_total)}</td>
                  <td>{job.links_found || 0}</td>
                  <td>{progress(job.products_done, job.products_total)}</td>
                  <td>{job.products_failed || 0}</td>
                  <td>{job.message || "—"}</td>
                  <td>
                    {job.status === "QUEUED" || job.status === "RUNNING" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="cancel" />
                        <input type="hidden" name="jobId" value={job.id} />
                        <button className="pv-button" type="submit">ОТМЕНИТЬ</button>
                      </Form>
                    ) : null}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={8}>Запусков Stone Island ещё нет.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
