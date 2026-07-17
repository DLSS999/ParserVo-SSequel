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

const crawlerStyles = `
  .pvc-viewport,
  .pvc-viewport * {
    box-sizing: border-box;
  }

  .pvc-viewport {
    width: 100%;
    min-width: 0;
    overflow-x: hidden;
    color: #181818;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .pvc-page {
    position: relative;
    left: 50%;
    width: calc(100vw - 48px);
    max-width: 1680px;
    min-width: 0;
    min-height: calc(100vh - 120px);
    transform: translateX(-50%);
    padding: 24px 0 44px;
  }

  .pvc-page h1,
  .pvc-page h2,
  .pvc-page p {
    margin: 0;
  }

  .pvc-page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 20px;
  }

  .pvc-page-header h1 {
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: -0.025em;
  }

  .pvc-page-header p {
    margin-top: 7px;
    color: #656565;
    font-size: 14px;
    line-height: 1.5;
  }

  .pvc-status-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 320px;
  }

  .pvc-stack {
    display: grid;
    gap: 16px;
    min-width: 0;
  }

  .pvc-card {
    min-width: 0;
    overflow: hidden;
    border: 1px solid #d8d8d8;
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  }

  .pvc-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 54px;
    padding: 14px 18px;
    border-bottom: 1px solid #e4e4e4;
    background: #fafafa;
  }

  .pvc-card-title {
    font-size: 14px;
    line-height: 1.35;
    font-weight: 750;
    letter-spacing: 0.015em;
    text-transform: uppercase;
  }

  .pvc-card-body {
    padding: 18px;
  }

  .pvc-form {
    display: grid;
    gap: 16px;
  }

  .pvc-field {
    display: grid;
    min-width: 0;
    gap: 7px;
  }

  .pvc-label {
    display: block;
    color: #3f3f3f;
    font-size: 11px;
    line-height: 1.25;
    font-weight: 700;
    letter-spacing: 0.035em;
    text-transform: uppercase;
  }

  .pvc-input {
    width: 100%;
    min-width: 0;
    height: 42px;
    padding: 0 12px;
    border: 1px solid #bcbcbc;
    border-radius: 5px;
    background: #fff;
    color: #181818;
    font: inherit;
    font-size: 14px;
    line-height: 1;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  .pvc-input:focus {
    border-color: #111;
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.08);
  }

  .pvc-input[readonly] {
    background: #f7f7f7;
    color: #4c4c4c;
  }

  .pvc-url-field {
    width: 100%;
    max-width: none;
  }

  .pvc-settings-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(180px, 1fr));
    gap: 14px;
  }

  .pvc-connection-grid {
    display: grid;
    grid-template-columns: 1.2fr 0.9fr 1.45fr minmax(210px, 0.8fr);
    align-items: end;
    gap: 14px;
  }

  .pvc-note {
    padding: 11px 13px;
    border-left: 3px solid #111;
    background: #f6f6f6;
    color: #555;
    font-size: 13px;
    line-height: 1.5;
  }

  .pvc-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid #9f9f9f;
    border-radius: 5px;
    background: #fff;
    color: #171717;
    font: inherit;
    font-size: 11px;
    line-height: 1;
    font-weight: 750;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .pvc-button:hover:not(:disabled) {
    border-color: #111;
    background: #f0f0f0;
  }

  .pvc-button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .pvc-button-primary {
    width: 100%;
    min-height: 46px;
    border-color: #111;
    background: #111;
    color: #fff;
  }

  .pvc-button-primary:hover:not(:disabled) {
    background: #2b2b2b;
    color: #fff;
  }

  .pvc-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 27px;
    padding: 0 10px;
    border: 1px solid #c8c8c8;
    border-radius: 999px;
    background: #fff;
    color: #383838;
    font-size: 10px;
    line-height: 1;
    font-weight: 750;
    letter-spacing: 0.035em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .pvc-pill-green {
    border-color: #b7d7bd;
    background: #eff8f1;
    color: #226331;
  }

  .pvc-pill-red {
    border-color: #e5bcbc;
    background: #fff1f1;
    color: #8d2020;
  }

  .pvc-pill-neutral {
    border-color: #d0d0d0;
    background: #f6f6f6;
    color: #505050;
  }

  .pvc-alert {
    padding: 12px 14px;
    border: 1px solid;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.45;
  }

  .pvc-alert-success {
    border-color: #bdd9c2;
    background: #f0f8f1;
    color: #1c5f2c;
  }

  .pvc-alert-error {
    border-color: #e5bcbc;
    background: #fff1f1;
    color: #8d2020;
  }

  .pvc-metric {
    min-width: 0;
    padding: 3px 0 1px;
  }

  .pvc-metric-value {
    margin-top: 8px;
    font-size: 15px;
    line-height: 1.25;
    font-weight: 600;
    white-space: nowrap;
  }

  .pvc-table-wrap {
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }

  .pvc-table {
    width: 100%;
    min-width: 1180px;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 13px;
  }

  .pvc-table th,
  .pvc-table td {
    padding: 11px 12px;
    border-bottom: 1px solid #e4e4e4;
    text-align: left;
    vertical-align: middle;
  }

  .pvc-table th {
    background: #fafafa;
    color: #505050;
    font-size: 10px;
    line-height: 1.2;
    font-weight: 750;
    letter-spacing: 0.035em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .pvc-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .pvc-table tbody tr:hover td {
    background: #fcfcfc;
  }

  .pvc-table-time { width: 150px; }
  .pvc-table-status { width: 112px; }
  .pvc-table-small { width: 88px; }
  .pvc-table-action { width: 118px; }

  .pvc-table-message {
    min-width: 360px;
    overflow-wrap: anywhere;
    color: #333;
    line-height: 1.4;
  }

  .pvc-empty {
    padding: 28px !important;
    color: #666;
    text-align: center !important;
  }

  @media (max-width: 1180px) {
    .pvc-page {
      width: calc(100vw - 32px);
    }

    .pvc-settings-grid,
    .pvc-connection-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .pvc-page {
      position: static;
      left: auto;
      width: 100%;
      transform: none;
      padding: 18px 14px 34px;
    }

    .pvc-page-header {
      display: grid;
    }

    .pvc-page-header h1 {
      font-size: 22px;
    }

    .pvc-status-row {
      justify-content: flex-start;
      min-width: 0;
    }

    .pvc-settings-grid,
    .pvc-connection-grid {
      grid-template-columns: 1fr;
    }

    .pvc-card-header {
      align-items: flex-start;
      flex-direction: column;
    }
  }
`;

function dateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function statusClass(status: string) {
  if (status === "COMPLETED") return "pvc-pill-green";
  if (status === "ERROR" || status === "CANCELLED") return "pvc-pill-red";
  return "pvc-pill-neutral";
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
    <>
      <style dangerouslySetInnerHTML={{ __html: crawlerStyles }} />
      <div className="pvc-viewport">
        <main className="pvc-page">
          <header className="pvc-page-header">
            <div>
              <h1>STONE ISLAND / IMPORT CONTROL</h1>
              <p>Вставьте ссылку каталога, задайте параметры и запустите импорт.</p>
            </div>
            <div className="pvc-status-row">
              <span className={`pvc-pill ${data.queueReady ? "pvc-pill-green" : "pvc-pill-red"}`}>
                {data.queueReady ? "Очередь подключена" : "Очередь не настроена"}
              </span>
              <span className={`pvc-pill ${extensionOnline ? "pvc-pill-green" : "pvc-pill-red"}`}>
                {extensionOnline ? "Chrome Capture онлайн" : "Chrome Capture офлайн"}
              </span>
            </div>
          </header>

          <div className="pvc-stack">
            {actionData?.message ? (
              <div className={`pvc-alert ${actionData.ok ? "pvc-alert-success" : "pvc-alert-error"}`}>
                {actionData.message}
              </div>
            ) : null}
            {data.queueError ? <div className="pvc-alert pvc-alert-error">{data.queueError}</div> : null}

            <section className="pvc-card">
              <div className="pvc-card-header">
                <h2 className="pvc-card-title">1. Вставьте ссылку Stone Island</h2>
                <span className="pvc-pill pvc-pill-neutral">Польская версия / PLN</span>
              </div>
              <div className="pvc-card-body">
                <Form method="post" className="pvc-form">
                  <input type="hidden" name="intent" value="enqueue" />

                  <label className="pvc-field pvc-url-field">
                    <span className="pvc-label">Ссылка на каталог или категорию</span>
                    <input
                      className="pvc-input"
                      name="catalogUrl"
                      type="url"
                      required
                      defaultValue={data.defaultStoneUrl}
                      placeholder="https://www.stoneisland.com/en-pl/men/sales/view-all-sales"
                    />
                  </label>

                  <div className="pvc-settings-grid">
                    <label className="pvc-field">
                      <span className="pvc-label">Курс PLN → UAH</span>
                      <input className="pvc-input" name="plnRate" inputMode="decimal" defaultValue="12,19" required />
                    </label>
                    <label className="pvc-field">
                      <span className="pvc-label">Остаток каждого размера</span>
                      <input className="pvc-input" name="quantity" type="number" min="0" step="1" defaultValue="5" required />
                    </label>
                    <label className="pvc-field">
                      <span className="pvc-label">Лимит товаров для запуска</span>
                      <input className="pvc-input" name="maxProducts" type="number" min="0" step="1" defaultValue="5" title="0 = все товары" />
                    </label>
                    <label className="pvc-field">
                      <span className="pvc-label">Товаров за одно Load More</span>
                      <input className="pvc-input" name="itemsPerLoad" type="number" min="1" max="200" step="1" defaultValue="16" required />
                    </label>
                  </div>

                  <div className="pvc-note">
                    Stone Island загружает товары партиями. При лимите 544 и партии 16 расширение выполнит минимум 33 нажатия Load More и после каждого нажатия проверит фактический рост ссылок.
                  </div>

                  <button className="pvc-button pvc-button-primary" type="submit" disabled={!data.queueReady || !extensionOnline}>
                    Найти товары и импортировать
                  </button>
                </Form>
              </div>
            </section>

            <section className="pvc-card">
              <div className="pvc-card-header">
                <h2 className="pvc-card-title">2. Подключение Chrome Capture</h2>
                <span className={`pvc-pill ${extensionOnline ? "pvc-pill-green" : "pvc-pill-red"}`}>
                  {extensionOnline ? data.onlineAgent?.message || "Расширение готово" : "Нужно подключить расширение"}
                </span>
              </div>
              <div className="pvc-card-body">
                <div className="pvc-connection-grid">
                  <label className="pvc-field">
                    <span className="pvc-label">API Base URL</span>
                    <input className="pvc-input" readOnly value={data.apiBaseUrl} />
                  </label>
                  <label className="pvc-field">
                    <span className="pvc-label">Shop</span>
                    <input className="pvc-input" readOnly value={data.shop} />
                  </label>
                  <label className="pvc-field">
                    <span className="pvc-label">Browser Capture Token</span>
                    <input className="pvc-input" readOnly value={data.captureToken} />
                  </label>
                  <div className="pvc-metric">
                    <div className="pvc-label">Последний heartbeat</div>
                    <div className="pvc-metric-value">{data.onlineAgent ? dateTime(data.onlineAgent.last_seen_at) : "Нет подключения"}</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="pvc-card">
              <div className="pvc-card-header">
                <h2 className="pvc-card-title">3. Прогресс и результат</h2>
                <button className="pvc-button" type="button" onClick={() => revalidator.revalidate()}>
                  Обновить
                </button>
              </div>
              <div className="pvc-table-wrap">
                <table className="pvc-table">
                  <thead>
                    <tr>
                      <th className="pvc-table-time">Время</th>
                      <th className="pvc-table-status">Статус</th>
                      <th className="pvc-table-small">Страницы</th>
                      <th className="pvc-table-small">Ссылки</th>
                      <th className="pvc-table-small">Товары</th>
                      <th className="pvc-table-small">Ошибки</th>
                      <th>Сообщение</th>
                      <th className="pvc-table-action">Действие</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.length ? data.jobs.map((job) => (
                      <tr key={job.id}>
                        <td>{dateTime(job.requested_at)}</td>
                        <td><span className={`pvc-pill ${statusClass(job.status)}`}>{job.status}</span></td>
                        <td>{progress(job.pages_done, job.pages_total)}</td>
                        <td>{job.links_found || 0}</td>
                        <td>{progress(job.products_done, job.products_total)}</td>
                        <td>{job.products_failed || 0}</td>
                        <td className="pvc-table-message">{job.message || "—"}</td>
                        <td>
                          {job.status === "QUEUED" || job.status === "RUNNING" ? (
                            <Form method="post">
                              <input type="hidden" name="intent" value="cancel" />
                              <input type="hidden" name="jobId" value={job.id} />
                              <button className="pvc-button" type="submit">Отменить</button>
                            </Form>
                          ) : "—"}
                        </td>
                      </tr>
                    )) : (
                      <tr><td className="pvc-empty" colSpan={8}>Запусков Stone Island ещё нет.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </main>
      </div>
    </>
  );
}
