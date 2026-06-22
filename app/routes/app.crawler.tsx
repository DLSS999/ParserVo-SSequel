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

const categories = [
  { id: "all", source: "Оба сайта", category: "Весь каталог", expected: 2667 },
  { id: "nap-clothing", source: "NET-A-PORTER / Women", category: "Clothing", expected: 700 },
  { id: "nap-shoes", source: "NET-A-PORTER / Women", category: "Shoes", expected: 299 },
  { id: "nap-bags", source: "NET-A-PORTER / Women", category: "Bags", expected: 146 },
  { id: "nap-accessories", source: "NET-A-PORTER / Women", category: "Accessories", expected: 137 },
  { id: "mrp-clothing", source: "MR PORTER / Men", category: "Clothing", expected: 910 },
  { id: "mrp-shoes", source: "MR PORTER / Men", category: "Shoes", expected: 282 },
  { id: "mrp-bags", source: "MR PORTER / Men", category: "Bags", expected: 37 },
  { id: "mrp-accessories", source: "MR PORTER / Men", category: "Accessories", expected: 156 },
];

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
    agents,
    onlineAgent,
    queueReady,
    queueError,
    categories,
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

    const categoryId = String(form.get("categoryId") || "all");
    const maxProductsRaw = Number(form.get("maxProducts") || 0);
    const maxProducts = Number.isFinite(maxProductsRaw) ? Math.max(0, Math.trunc(maxProductsRaw)) : 0;
    const job = await enqueueCrawlJob({
      shopDomain: session.shop,
      categoryId,
      maxProducts,
    });

    return json({
      ok: true,
      message: `Задание ${categoryId} добавлено в очередь Chrome Capture.`,
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
          <h1>ParserVo NET-A-PORTER / MR PORTER Capture</h1>
          <p>После одноразовой установки расширения все запуски выполняются только здесь.</p>
        </div>
        <div className="pv-header">
          <span className={`pv-pill ${data.queueReady ? "pv-pill-green" : "pv-pill-red"}`}>
            {data.queueReady ? "Очередь подключена" : "Очередь не настроена"}
          </span>
          <span className={`pv-pill ${extensionOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {extensionOnline ? `Chrome Capture онлайн: ${data.onlineAgent?.agent_id}` : "Chrome Capture офлайн"}
          </span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>{actionData.message}</div>
      ) : null}
      {data.queueError ? <div className="pv-alert pv-alert-error">{data.queueError}</div> : null}

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">Настройка расширения Chrome</h2>
          <span className={`pv-pill ${extensionOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {extensionOnline ? data.onlineAgent?.message || "Расширение готово" : "вставь настройки и нажми Test API"}
          </span>
        </div>
        <p className="pv-note">
          Установи ParserVo YNAP Capture через chrome://extensions, затем скопируй эти три значения в popup расширения. Supabase Secret Key расширению не нужен.
        </p>
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

      {!extensionOnline ? (
        <div className="pv-alert pv-alert-error">
          Расширение Chrome не подключено. Очередь принимает задания, но они останутся QUEUED до успешного Test API в расширении.
        </div>
      ) : null}

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">Запустить парсинг</h2>
          <span className={`pv-pill ${extensionOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {extensionOnline ? "готово" : "ожидание расширения"}
          </span>
        </div>
        <p className="pv-note">
          Chrome Capture открывает страницы через твой обычный Chrome, сохраняет до 5 фото, размеры и цены, а затем автоматически создаёт или обновляет товар Shopify.
        </p>
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Источник</th><th>Категория</th><th>Ожидается</th><th>Тестовый лимит</th><th>Действие</th></tr></thead>
            <tbody>
              {data.categories.map((category) => (
                <tr key={category.id}>
                  <td>{category.source}</td>
                  <td>{category.category}</td>
                  <td>{category.expected}</td>
                  <td>
                    <Form method="post" className="pv-inline-form">
                      <input type="hidden" name="intent" value="enqueue" />
                      <input type="hidden" name="categoryId" value={category.id} />
                      <input name="maxProducts" type="number" min="0" step="1" defaultValue={category.id === "all" ? 0 : 5} title="0 = без лимита" />
                      <button className="pv-button pv-button-primary" type="submit" disabled={!data.queueReady || !extensionOnline}>
                        {category.id === "all" ? "Скачать весь каталог" : "Запустить"}
                      </button>
                    </Form>
                  </td>
                  <td><span className="pv-note">0 = без лимита</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">Очередь и прогресс</h2>
          <button className="pv-button" type="button" onClick={() => revalidator.revalidate()}>Обновить</button>
        </div>
        <div className="pv-table-wrap">
          <table className="pv-table">
            <thead><tr><th>Время</th><th>Категория</th><th>Статус</th><th>Страницы</th><th>Ссылки</th><th>Товары</th><th>Ошибки</th><th>Сообщение</th><th></th></tr></thead>
            <tbody>
              {data.jobs.length ? data.jobs.map((job) => (
                <tr key={job.id}>
                  <td>{dateTime(job.requested_at)}</td>
                  <td>{job.category_id}</td>
                  <td><span className={`pv-pill ${statusClass(job.status)}`}>{job.status}</span></td>
                  <td>{progress(job.pages_done, job.pages_total)}</td>
                  <td>{job.links_found || 0}</td>
                  <td>{progress(job.products_done, job.products_total)}</td>
                  <td>{job.products_failed || 0}</td>
                  <td>{job.message || "—"}</td>
                  <td>
                    {job.status === "QUEUED" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="cancel" />
                        <input type="hidden" name="jobId" value={job.id} />
                        <button className="pv-button" type="submit">Отменить</button>
                      </Form>
                    ) : null}
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={9}>Заданий ещё нет.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
