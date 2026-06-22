import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
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
    return Number.isFinite(lastSeen) && now - lastSeen < 30000;
  }) || null;

  return json({
    shop: session.shop,
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
      message: `Задание ${categoryId} добавлено в очередь. Agent ID появится после запуска.`,
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
    if (!active && data.onlineAgent) return;
    const timer = window.setInterval(() => revalidator.revalidate(), 5000);
    return () => window.clearInterval(timer);
  }, [active, data.onlineAgent, revalidator]);

  const agentOnline = Boolean(data.onlineAgent);

  return (
    <main className="pv-stack">
      <div className="pv-page-header">
        <div>
          <h1>ParserVo Crawler</h1>
          <p>Управление парсингом только из Shopify-приложения. Магазин: {data.shop}</p>
        </div>
        <div className="pv-header">
          <span className={`pv-pill ${data.queueReady ? "pv-pill-green" : "pv-pill-red"}`}>
            {data.queueReady ? "Очередь подключена" : "Очередь не настроена"}
          </span>
          <span className={`pv-pill ${agentOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {agentOnline ? `Agent онлайн: ${data.onlineAgent?.hostname || data.onlineAgent?.agent_id}` : "Agent офлайн"}
          </span>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>{actionData.message}</div>
      ) : null}
      {data.queueError ? <div className="pv-alert pv-alert-error">{data.queueError}</div> : null}
      {!agentOnline ? (
        <div className="pv-alert pv-alert-error">
          Windows Agent не отправляет heartbeat. Задания останутся QUEUED, пока Agent не запущен.
        </div>
      ) : null}

      <section className="pv-card">
        <div className="pv-header">
          <h2 className="pv-title">Запустить парсинг</h2>
          <span className={`pv-pill ${agentOnline ? "pv-pill-green" : "pv-pill-red"}`}>
            {agentOnline ? data.onlineAgent?.message || "Agent готов" : "сначала запусти Agent"}
          </span>
        </div>
        <p className="pv-note">
          Кнопка создаёт задание. Фоновый ParserVo Agent на Windows забирает его, открывает локальный Chrome, сохраняет товары в Supabase и затем синхронизирует Shopify.
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
                      <button className="pv-button pv-button-primary" type="submit" disabled={!data.queueReady || !agentOnline}>
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
            <thead><tr><th>Время</th><th>Категория</th><th>Лимит</th><th>Статус</th><th>Agent</th><th>Сообщение</th><th></th></tr></thead>
            <tbody>
              {data.jobs.length ? data.jobs.map((job) => (
                <tr key={job.id}>
                  <td>{dateTime(job.requested_at)}</td>
                  <td>{job.category_id}</td>
                  <td>{job.max_products || "все"}</td>
                  <td><span className={`pv-pill ${statusClass(job.status)}`}>{job.status}</span></td>
                  <td>{job.agent_id || "ожидание"}</td>
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
                <tr><td colSpan={7}>Заданий ещё нет.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
