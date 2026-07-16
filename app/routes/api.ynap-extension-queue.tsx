import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  claimBrowserCrawlJob,
  databaseAdminRequest,
  recordBrowserHeartbeat,
  updateBrowserCrawlJob,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";
import { configsForJob } from "../services/ynap-browser-config.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-ParserVo-Token",
  "Cache-Control": "no-store",
};

function reply(data: unknown, status = 200) {
  return json(data, { status, headers: corsHeaders });
}

async function jobStatus(jobId: string, shop: string) {
  const rows = await databaseAdminRequest(
    `parservo_crawl_jobs?id=eq.${encodeURIComponent(jobId)}&shop_domain=eq.${encodeURIComponent(shop)}&select=id,status&limit=1`,
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

function progressPatch(payload: Record<string, unknown>) {
  return {
    pages_total: Number(payload.pagesTotal || 0),
    pages_done: Number(payload.pagesDone || 0),
    links_found: Number(payload.linksFound || 0),
    products_total: Number(payload.productsTotal || 0),
    products_done: Number(payload.productsDone || 0),
    errors_count: Number(payload.productsFailed || 0),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return reply({
    ok: true,
    name: "ParserVo Stone Island Chrome queue API",
    version: "2.4.0",
    actions: ["heartbeat", "test", "claim", "job-status", "progress", "complete", "error"],
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const payload = JSON.parse((await request.text()) || "{}") as Record<string, any>;
    const shop = String(payload.shop || "").trim().toLowerCase();
    const token = String(
      request.headers.get("X-ParserVo-Token") || payload.token || "",
    ).trim();
    const agentId = String(payload.agentId || "chrome-extension");
    const operation = String(payload.action || "heartbeat");

    if (!shop || !verifyBrowserCaptureKey(shop, token)) {
      return reply({ ok: false, error: "Invalid shop or browser capture key." }, 401);
    }

    if (operation === "heartbeat" || operation === "test") {
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: payload.status || "ONLINE",
        message: payload.message || "Chrome extension online",
        currentJobId: payload.jobId || null,
      });
      return reply({ ok: true, online: true });
    }

    if (operation === "claim") {
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "ONLINE",
        message: "Checking queue",
      });

      const job = await claimBrowserCrawlJob(shop, agentId);
      if (!job) return reply({ ok: true, job: null });

      const configs = configsForJob(String(job.category_id || "all"));
      if (!configs.length) {
        await updateBrowserCrawlJob(job.id, {
          status: "ERROR",
          finished_at: new Date().toISOString(),
          message: `Unknown category: ${job.category_id}`,
        });
        return reply({ ok: false, error: "Unknown category." }, 400);
      }

      const pagesTotal = configs.reduce((sum, config) => sum + Number(config.pages || 0), 0);
      await updateBrowserCrawlJob(job.id, {
        status: "RUNNING",
        phase: "LEGACY",
        pages_total: pagesTotal,
        message: "Chrome Capture started catalog processing",
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "BUSY",
        message: `Processing ${job.category_id}`,
        currentJobId: job.id,
      });

      return reply({
        ok: true,
        job: {
          ...job,
          phase: "LEGACY",
          max_products: Number(job.max_products || 0),
          configs,
        },
      });
    }

    if (!payload.jobId) {
      return reply({ ok: false, error: "Missing jobId." }, 400);
    }

    const currentJob = await jobStatus(String(payload.jobId), shop);
    if (!currentJob) return reply({ ok: false, error: "Job not found for this shop." }, 404);

    if (operation === "job-status") {
      return reply({
        ok: true,
        status: currentJob.status,
        cancelled: currentJob.status === "CANCELLED",
        terminal: ["COMPLETED", "PARTIAL", "ERROR", "CANCELLED"].includes(currentJob.status),
      });
    }

    if (currentJob.status === "CANCELLED") {
      return reply({ ok: true, status: "CANCELLED", cancelled: true });
    }

    if (operation === "progress") {
      await updateBrowserCrawlJob(payload.jobId, {
        ...progressPatch(payload),
        status: "RUNNING",
        phase: "LEGACY",
        message: payload.message || "Processing catalog",
        result: payload.result || null,
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "BUSY",
        message: payload.message || "Processing catalog",
        currentJobId: payload.jobId,
      });
      return reply({ ok: true });
    }

    if (operation === "complete") {
      const failed = Number(payload.productsFailed || 0);
      const done = Number(payload.productsDone || 0);
      const total = Number(payload.productsTotal || done);
      const status = failed > 0 ? "PARTIAL" : "COMPLETED";

      await updateBrowserCrawlJob(payload.jobId, {
        ...progressPatch(payload),
        status,
        phase: "DONE",
        finished_at: new Date().toISOString(),
        message: payload.message || `Completed ${done}/${total}; errors ${failed}`,
        result: payload.result || null,
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "ONLINE",
        message: `Completed ${done}/${total}`,
      });
      return reply({ ok: true, status });
    }

    if (operation === "error") {
      await updateBrowserCrawlJob(payload.jobId, {
        ...progressPatch(payload),
        status: "ERROR",
        finished_at: new Date().toISOString(),
        message: payload.message || "Extension job error",
        result: payload.result || null,
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "ONLINE",
        message: payload.message || "Waiting for jobs",
      });
      return reply({ ok: true, status: "ERROR" });
    }

    return reply({ ok: false, error: `Unknown action: ${operation}` }, 400);
  } catch (error) {
    return reply({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown queue error",
    }, 500);
  }
}
