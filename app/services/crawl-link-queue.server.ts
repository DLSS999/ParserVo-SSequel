import {
  databaseAdminHeaders,
  databaseAdminRequest,
} from "./browser-capture.server";

export type CrawlLinkInput = {
  url: string;
  categoryId: string;
  source?: string;
  gender?: string;
  category?: string;
};

export type CrawlLinkRow = {
  id: string;
  job_id: string;
  category_id: string;
  source: string | null;
  gender: string | null;
  category: string | null;
  url: string;
  status: string;
  attempts: number;
  agent_id: string | null;
  product_handle: string | null;
  last_error: string | null;
  next_retry_at: string | null;
};

export type CrawlLinkStats = {
  total: number;
  pending: number;
  running: number;
  success: number;
  retry: number;
  failed: number;
  blocked: number;
};

function uniqueLinks(links: CrawlLinkInput[]) {
  const map = new Map<string, CrawlLinkInput>();
  for (const link of links) {
    const url = String(link.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!map.has(url)) {
      map.set(url, {
        url,
        categoryId: String(link.categoryId || ""),
        source: link.source || null,
        gender: link.gender || null,
        category: link.category || null,
      });
    }
  }
  return [...map.values()];
}

export async function storeCrawlLinks(jobId: string, links: CrawlLinkInput[]) {
  const unique = uniqueLinks(links);
  if (!unique.length) return { inserted: 0 };

  const batchSize = 400;
  for (let index = 0; index < unique.length; index += batchSize) {
    const batch = unique.slice(index, index + batchSize);
    await databaseAdminRequest("parservo_crawl_links?on_conflict=job_id,url", {
      method: "POST",
      headers: databaseAdminHeaders("resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify(batch.map((link) => ({
        job_id: jobId,
        category_id: link.categoryId,
        source: link.source || null,
        gender: link.gender || null,
        category: link.category || null,
        url: link.url,
        status: "PENDING",
        updated_at: new Date().toISOString(),
      }))),
    });
  }

  await reconcileCrawlLinks(jobId);
  return { inserted: unique.length };
}

export async function reconcileCrawlLinks(jobId: string) {
  const result = await databaseAdminRequest("rpc/parservo_reconcile_crawl_links", {
    method: "POST",
    body: JSON.stringify({ p_job_id: jobId }),
  });
  return Number(Array.isArray(result) ? result[0] || 0 : result || 0);
}

export async function getCrawlLinkStats(jobId: string): Promise<CrawlLinkStats> {
  const result = await databaseAdminRequest("rpc/parservo_crawl_link_stats", {
    method: "POST",
    body: JSON.stringify({ p_job_id: jobId }),
  });
  const row = Array.isArray(result) ? result[0] || {} : result || {};
  return {
    total: Number(row.total || 0),
    pending: Number(row.pending || 0),
    running: Number(row.running || 0),
    success: Number(row.success || 0),
    retry: Number(row.retry || 0),
    failed: Number(row.failed || 0),
    blocked: Number(row.blocked || 0),
  };
}

export async function claimCrawlLinks(jobId: string, agentId: string, limit = 1): Promise<CrawlLinkRow[]> {
  const result = await databaseAdminRequest("rpc/parservo_claim_crawl_links", {
    method: "POST",
    body: JSON.stringify({
      p_job_id: jobId,
      p_agent_id: agentId,
      p_limit: Math.max(1, Math.min(20, Math.trunc(limit))),
    }),
  });
  return Array.isArray(result) ? result as CrawlLinkRow[] : [];
}

export async function markCrawlLinkSuccess(input: {
  linkId: string;
  productHandle: string;
}) {
  await databaseAdminRequest(`parservo_crawl_links?id=eq.${encodeURIComponent(input.linkId)}`, {
    method: "PATCH",
    headers: databaseAdminHeaders("return=minimal"),
    body: JSON.stringify({
      status: "SUCCESS",
      product_handle: input.productHandle,
      last_error: null,
      next_retry_at: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function markCrawlLinkFailure(input: {
  linkId: string;
  error: string;
  retryable: boolean;
  blocked?: boolean;
  retryAfterMinutes?: number;
  attempts?: number;
}) {
  const attempts = Number(input.attempts || 1);
  let status = input.blocked ? "BLOCKED" : input.retryable && attempts < 4 ? "RETRY" : "FAILED";
  const retryAfterMinutes = Math.max(1, Math.min(1440, Number(input.retryAfterMinutes || (input.blocked ? 30 : 10))));

  await databaseAdminRequest(`parservo_crawl_links?id=eq.${encodeURIComponent(input.linkId)}`, {
    method: "PATCH",
    headers: databaseAdminHeaders("return=minimal"),
    body: JSON.stringify({
      status,
      last_error: String(input.error || "Unknown capture error").slice(0, 2000),
      next_retry_at: status === "RETRY" || status === "BLOCKED"
        ? new Date(Date.now() + retryAfterMinutes * 60_000).toISOString()
        : null,
      finished_at: status === "FAILED" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  });

  return status;
}

export async function retryFailedCrawlLinks(jobId: string) {
  const result = await databaseAdminRequest("rpc/parservo_retry_crawl_links", {
    method: "POST",
    body: JSON.stringify({ p_job_id: jobId }),
  });
  return Number(Array.isArray(result) ? result[0] || 0 : result || 0);
}
