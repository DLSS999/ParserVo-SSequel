import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

function databaseConfig() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not configured in Vercel.");
  return { url, key };
}

function apiHeaders(key: string, prefer?: string) {
  const result: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  if (key.startsWith("eyJ")) result.Authorization = `Bearer ${key}`;
  if (prefer) result.Prefer = prefer;
  return result;
}

async function databaseRequest(path: string, init: RequestInit = {}) {
  const { url, key } = databaseConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...apiHeaders(key),
      ...((init.headers || {}) as Record<string, string>),
    },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase browser capture ${response.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}

export function browserCaptureKey(shopDomain: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not configured.");
  return createHmac("sha256", secret)
    .update(`parservo-browser-capture:${shopDomain.toLowerCase()}`)
    .digest("hex");
}

export function verifyBrowserCaptureKey(shopDomain: string, supplied: string) {
  if (!shopDomain || !supplied) return false;
  const expected = browserCaptureKey(shopDomain);
  const left = Buffer.from(expected);
  const right = Buffer.from(String(supplied).trim());
  return left.length === right.length && timingSafeEqual(left, right);
}

async function findRunningJob(shopDomain: string) {
  const rows = await databaseRequest(
    `parservo_crawl_jobs?shop_domain=eq.${encodeURIComponent(shopDomain)}&status=eq.RUNNING&select=*&order=started_at.asc&limit=1`,
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function claimBrowserCrawlJob(shopDomain: string, agentId: string) {
  const running = await findRunningJob(shopDomain);
  if (running?.id) {
    await updateBrowserCrawlJob(running.id, {
      agent_id: agentId,
      message: "Chrome extension resumed the running job",
    });
    return {
      ...running,
      agent_id: agentId,
    };
  }

  const data = await databaseRequest("rpc/parservo_claim_crawl_job", {
    method: "POST",
    body: JSON.stringify({ p_agent_id: agentId }),
  });
  const job = Array.isArray(data) ? data[0] : data;
  if (!job?.id) return null;

  if (job.shop_domain && job.shop_domain !== shopDomain) {
    await updateBrowserCrawlJob(job.id, {
      status: "QUEUED",
      started_at: null,
      agent_id: null,
      message: "Waiting for the matching shop extension",
    });
    return null;
  }

  return job;
}

export async function updateBrowserCrawlJob(jobId: string, patch: Record<string, unknown>) {
  await databaseRequest(`parservo_crawl_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: apiHeaders(databaseConfig().key, "return=minimal"),
    body: JSON.stringify(patch),
  });
}

export async function recordBrowserHeartbeat(input: {
  shopDomain: string;
  agentId: string;
  version?: string;
  status?: string;
  message?: string;
  currentJobId?: string | null;
}) {
  await databaseRequest("parservo_agents?on_conflict=agent_id", {
    method: "POST",
    headers: apiHeaders(databaseConfig().key, "resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify([{
      agent_id: input.agentId,
      shop_domain: input.shopDomain,
      hostname: "Chrome extension",
      status: input.status || "ONLINE",
      current_job_id: input.currentJobId || null,
      message: input.message || "Waiting for jobs",
      version: input.version || null,
      last_seen_at: new Date().toISOString(),
    }]),
  });
}

export async function databaseAdminRequest(path: string, init: RequestInit = {}) {
  return databaseRequest(path, init);
}

export function databaseAdminHeaders(prefer?: string) {
  return apiHeaders(databaseConfig().key, prefer);
}
