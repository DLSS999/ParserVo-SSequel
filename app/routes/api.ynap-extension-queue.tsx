import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  claimBrowserCrawlJob,
  recordBrowserHeartbeat,
  updateBrowserCrawlJob,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";
import { configsForJob } from "../services/ynap-browser-config.server";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-ParserVo-Token",
  "Cache-Control": "no-store",
};

function response(data: unknown, status = 200) {
  return json(data, { status, headers });
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  return response({ ok: true, name: "ParserVo YNAP queue API" });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    const payload = JSON.parse((await request.text()) || "{}");
    const shop = String(payload.shop || "").trim().toLowerCase();
    const key = String(
      request.headers.get("X-ParserVo-Token") || payload.token || "",
    ).trim();
    const agentId = String(payload.agentId || "chrome-extension");
    const operation = String(payload.action || "heartbeat");

    if (!shop || !verifyBrowserCaptureKey(shop, key)) {
      return response({ ok: false, error: "Invalid shop or browser capture key." }, 401);
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
      return response({ ok: true, online: true });
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
      if (!job) return response({ ok: true, job: null });

      const configs = configsForJob(String(job.category_id || "all"));
      if (!configs.length) {
        await updateBrowserCrawlJob(job.id, {
          status: "ERROR",
          finished_at: new Date().toISOString(),
          message: `Unknown category: ${job.category_id}`,
        });
        return response({ ok: false, error: "Unknown category" }, 400);
      }

      const pagesTotal = configs.reduce((sum, config) => sum + config.pages, 0);
      await updateBrowserCrawlJob(job.id, {
        status: "RUNNING",
        pages_total: pagesTotal,
        message: "Chrome extension claimed the job",
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "BUSY",
        message: `Processing ${job.category_id}`,
        currentJobId: job.id,
      });

      return response({
        ok: true,
        job: {
          ...job,
          max_products: Number(job.max_products || 0),
          configs,
        },
      });
    }

    if (!payload.jobId) {
      return response({ ok: false, error: "Missing jobId." }, 400);
    }

    const patch = {
      pages_total: Number(payload.pagesTotal || 0),
      pages_done: Number(payload.pagesDone || 0),
      links_found: Number(payload.linksFound || 0),
      products_total: Number(payload.productsTotal || 0),
      products_done: Number(payload.productsDone || 0),
      errors_count: Number(payload.productsFailed || 0),
      message: payload.message || operation,
      result: payload.result || null,
    };

    if (operation === "progress") {
      await updateBrowserCrawlJob(payload.jobId, {
        ...patch,
        status: "RUNNING",
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "BUSY",
        message: payload.message || "Processing catalog",
        currentJobId: payload.jobId,
      });
      return response({ ok: true });
    }

    if (operation === "complete" || operation === "error") {
      const status = operation === "error"
        ? "ERROR"
        : Number(payload.productsFailed || 0) > 0
          ? "PARTIAL"
          : "COMPLETED";

      await updateBrowserCrawlJob(payload.jobId, {
        ...patch,
        status,
        finished_at: new Date().toISOString(),
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "ONLINE",
        message: payload.message || "Waiting for jobs",
      });
      return response({ ok: true, status });
    }

    return response({ ok: false, error: `Unknown action: ${operation}` }, 400);
  } catch (error) {
    return response({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown queue error",
    }, 500);
  }
}
