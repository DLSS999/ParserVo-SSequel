const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_DELAYS_MS = [250, 750, 1500];
const MIN_CHROME_CAPTURE_VERSION = "2.9.6";

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function versionParts(value: string | null | undefined) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : [0, 0, 0];
}

function versionAtLeast(actual: string | null | undefined, minimum: string) {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const method = String(init.method || "GET").toUpperCase();
  const retryable = ["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(method);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: {
          ...headers(key),
          ...((init.headers || {}) as Record<string, string>),
        },
        cache: "no-store",
      });
    } catch (error) {
      lastError = error;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : null;

    const error = new Error(`Supabase queue ${response.status}: ${text.slice(0, 500)}`);
    lastError = error;
    if (!retryable || !RETRYABLE_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) throw error;
    await wait(RETRY_DELAYS_MS[attempt]);
  }

  throw lastError instanceof Error ? lastError : new Error("Supabase queue request failed.");
}

export async function enqueueCrawlJob(input: {
  shopDomain: string;
  categoryId: string;
  maxProducts?: number;
}) {
  const agents = await listParserVoAgents(input.shopDomain);
  const now = Date.now();
  const activeAgent = agents.find((agent) => {
    const lastSeen = new Date(agent.last_seen_at).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen < 45000;
  });

  if (activeAgent && !versionAtLeast(activeAgent.version, MIN_CHROME_CAPTURE_VERSION)) {
    throw new Error(
      `Подключено устаревшее Chrome Capture v${activeAgent.version || "unknown"}. `
      + `Удалите старое расширение и установите v${MIN_CHROME_CAPTURE_VERSION}. Задание не создано.`,
    );
  }

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
