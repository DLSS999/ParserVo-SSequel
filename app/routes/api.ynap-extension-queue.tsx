import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  claimBrowserCrawlJob,
  recordBrowserHeartbeat,
  updateBrowserCrawlJob,
  verifyBrowserCaptureKey,
} from "../services/browser-capture.server";
import {
  claimCrawlLinks,
  getCrawlLinkStats,
  markCrawlLinkFailure,
  reconcileCrawlLinks,
  storeCrawlLinks,
} from "../services/crawl-link-queue.server";
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

function jobProgressPatch(stats: Awaited<ReturnType<typeof getCrawlLinkStats>>) {
  return {
    links_found: stats.total,
    products_total: stats.total,
    products_done: stats.success,
    errors_count: stats.retry + stats.failed + stats.blocked,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  return response({ ok: true, name: "ParserVo staged YNAP queue API" });
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
        message: "Checking staged queue",
      });

      const job = await claimBrowserCrawlJob(shop, agentId);
      if (!job) return response({ ok: true, job: null });

      const phase = String(job.phase || "COLLECT_LINKS");
      const configs = phase === "COLLECT_LINKS"
        ? configsForJob(String(job.category_id || "all"))
        : [];

      if (phase === "COLLECT_LINKS" && !configs.length) {
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
        pages_total: phase === "COLLECT_LINKS" ? pagesTotal : Number(job.pages_total || 0),
        message: phase === "COLLECT_LINKS"
          ? "Chrome extension started link collection"
          : "Chrome extension started product download",
      });

      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "BUSY",
        message: `Processing ${job.category_id}: ${phase}`,
        currentJobId: job.id,
      });

      return response({
        ok: true,
        job: {
          ...job,
          phase,
          max_products: Number(job.max_products || 0),
          configs,
        },
      });
    }

    if (!payload.jobId) {
      return response({ ok: false, error: "Missing jobId." }, 400);
    }

    if (operation === "store_links") {
      const links = Array.isArray(payload.links) ? payload.links : [];
      const stored = await storeCrawlLinks(payload.jobId, links);
      const stats = await getCrawlLinkStats(payload.jobId);
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
        status: "RUNNING",
        phase: "COLLECT_LINKS",
        pages_total: Number(payload.pagesTotal || 0),
        pages_done: Number(payload.pagesDone || 0),
        message: payload.message || `Stored ${stats.total} unique links`,
      });
      return response({ ok: true, stored, stats });
    }

    if (operation === "links_complete") {
      await reconcileCrawlLinks(payload.jobId);
      const stats = await getCrawlLinkStats(payload.jobId);
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
        status: "LINKS_READY",
        phase: "LINKS_READY",
        links_completed_at: new Date().toISOString(),
        pages_total: Number(payload.pagesTotal || 0),
        pages_done: Number(payload.pagesDone || 0),
        message: `Link collection complete: ${stats.total} links. Start product download from the app.`,
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "ONLINE",
        message: `Links ready: ${stats.total}`,
      });
      return response({ ok: true, status: "LINKS_READY", stats });
    }

    if (operation === "claim_links") {
      const links = await claimCrawlLinks(
        payload.jobId,
        agentId,
        Number(payload.limit || 1),
      );
      const stats = await getCrawlLinkStats(payload.jobId);
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
        status: "RUNNING",
        phase: "DOWNLOAD_PRODUCTS",
        message: links.length
          ? `Claimed ${links.length} product link(s)`
          : "No immediately available product links",
      });
      return response({ ok: true, links, stats });
    }

    if (operation === "link_error") {
      if (!payload.linkId) {
        return response({ ok: false, error: "Missing linkId." }, 400);
      }
      const status = await markCrawlLinkFailure({
        linkId: String(payload.linkId),
        error: String(payload.error || "Unknown product capture error"),
        retryable: payload.retryable !== false,
        blocked: Boolean(payload.blocked),
        retryAfterMinutes: Number(payload.retryAfterMinutes || 0) || undefined,
        attempts: Number(payload.attempts || 1),
      });
      const stats = await getCrawlLinkStats(payload.jobId);
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
        message: `Product link marked ${status}: ${String(payload.error || "error").slice(0, 300)}`,
      });
      return response({ ok: true, status, stats });
    }

    if (operation === "download_complete") {
      await reconcileCrawlLinks(payload.jobId);
      const stats = await getCrawlLinkStats(payload.jobId);
      const unresolved = stats.pending + stats.running + stats.retry + stats.failed + stats.blocked;
      const finalStatus = unresolved === 0 ? "COMPLETED" : "PARTIAL";
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
        status: finalStatus,
        phase: "DONE",
        finished_at: new Date().toISOString(),
        message: finalStatus === "COMPLETED"
          ? `All ${stats.success} products downloaded`
          : `Downloaded ${stats.success}/${stats.total}; retryable or failed ${unresolved}`,
      });
      await recordBrowserHeartbeat({
        shopDomain: shop,
        agentId,
        version: payload.version,
        status: "ONLINE",
        message: `Download ${finalStatus.toLowerCase()}: ${stats.success}/${stats.total}`,
      });
      return response({ ok: true, status: finalStatus, stats });
    }

    if (operation === "progress") {
      const stats = await getCrawlLinkStats(payload.jobId);
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
        pages_total: Number(payload.pagesTotal || 0),
        pages_done: Number(payload.pagesDone || 0),
        message: payload.message || "Working",
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
      return response({ ok: true, stats });
    }

    if (operation === "error") {
      const stats = await getCrawlLinkStats(payload.jobId);
      await updateBrowserCrawlJob(payload.jobId, {
        ...jobProgressPatch(stats),
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
      return response({ ok: true, status: "ERROR", stats });
    }

    return response({ ok: false, error: `Unknown action: ${operation}` }, 400);
  } catch (error) {
    return response({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown queue error",
    }, 500);
  }
}
