const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

export type CrawlJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "ERROR" | "CANCELLED";

export type CrawlJob = {
  id: string;
  shop_domain: string | null;
  category_id: string;
  max_products: number;
  status: CrawlJobStatus;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  agent_id: string | null;
  message: string | null;
  result: Record<string, unknown> | null;
  pages_total?: number | null;
  pages_done?: number | null;
  links_found?: number | null;
  products_total?: number | null;
  products_done?: number | null;
  products_failed?: number | null;
};

export type ParserVoAgent = {
  agent_id: string;
  shop_domain: string | null;
  hostname: string | null;
  status: string;
  current_job_id: string | null;
  message: string | null;
  version: string | null;
  started_at: string;
  last_seen_at: string;
};

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SECRET_KEY is missing in Vercel Environment Variables.");
  }
  return { url, key };
}

function headers(key: string, prefer?: string) {
  const result: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  if (key.startsWith("eyJ")) result.Authorization = `Bearer ${key}`;
  if (prefer) result.Prefer = prefer;
  return result;
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...headers(key),
      ...((init.headers || {}) as Record<string, string>),
    },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase queue ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export async function enqueueCrawlJob(input: {
  shopDomain: string;
  categoryId: string;
  maxProducts?: number;
}) {
  const rows = await rest("parservo_crawl_jobs", {
    method: "POST",
    headers: headers(config().key, "return=representation"),
    body: JSON.stringify([{
      shop_domain: input.shopDomain,
      category_id: input.categoryId,
      max_products: Math.max(0, Math.trunc(input.maxProducts || 0)),
      status: "QUEUED",
      message: "Waiting for ParserVo Chrome Capture",
    }]),
  });
  return rows?.[0] as CrawlJob;
}

export async function listCrawlJobs(shopDomain: string, limit = 20): Promise<CrawlJob[]> {
  const path = `parservo_crawl_jobs?shop_domain=eq.${encodeURIComponent(shopDomain)}&select=*&order=requested_at.desc&limit=${Math.max(1, Math.min(limit, 100))}`;
  const rows = await rest(path);
  return Array.isArray(rows) ? rows : [];
}

export async function listParserVoAgents(shopDomain: string): Promise<ParserVoAgent[]> {
  const path = `parservo_agents?shop_domain=eq.${encodeURIComponent(shopDomain)}&select=*&order=last_seen_at.desc&limit=20`;
  const rows = await rest(path);
  return Array.isArray(rows) ? rows : [];
}

export async function cancelCrawlJob(jobId: string, shopDomain: string) {
  await rest(`parservo_crawl_jobs?id=eq.${encodeURIComponent(jobId)}&shop_domain=eq.${encodeURIComponent(shopDomain)}&status=in.(QUEUED,RUNNING)`, {
    method: "PATCH",
    headers: headers(config().key, "return=minimal"),
    body: JSON.stringify({
      status: "CANCELLED",
      finished_at: new Date().toISOString(),
      message: "Cancelled in Shopify app",
    }),
  });
}
