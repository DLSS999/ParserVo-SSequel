const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_DELAYS_MS = [250, 750, 1500];

type ShopifySessionLike = {
  shop: string;
  accessToken?: string;
  scope?: string;
  isOnline?: boolean;
};

export type StoredShopTarget = {
  shop_domain: string;
  access_token: string;
  scope?: string | null;
  eur_rate: number;
  pln_rate: number;
  default_quantity: number;
  auto_sync: boolean;
  sync_interval_minutes: number;
};

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key };
}

export function hasSupabaseAdmin() {
  return Boolean(config().key);
}

function headers(key: string, extra: Record<string, string> = {}) {
  const result: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
    ...extra,
  };
  if (key.startsWith("eyJ")) result.Authorization = `Bearer ${key}`;
  return result;
}

function canRetry(path: string, init: RequestInit) {
  const method = String(init.method || "GET").toUpperCase();
  if (["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  if (method !== "POST") return false;
  return path.includes("on_conflict=") || String((init.headers as Record<string, string> | undefined)?.Prefer || "").includes("merge-duplicates");
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not configured.");

  const retryable = canRetry(path, init);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: headers(key, (init.headers || {}) as Record<string, string>),
        cache: "no-store",
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;

      const error = new Error(`Supabase admin ${response.status}: ${text.slice(0, 500)}`);
      lastError = error;
      if (!retryable || !RETRYABLE_STATUS.has(response.status) || attempt >= RETRY_DELAYS_MS.length) throw error;
    } catch (error) {
      lastError = error;
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
    }

    await wait(RETRY_DELAYS_MS[attempt]);
  }

  throw lastError instanceof Error ? lastError : new Error("Supabase admin request failed.");
}

export async function persistShopSession(session: ShopifySessionLike) {
  if (!session.accessToken || !hasSupabaseAdmin()) return false;
  await rest("parservo_shop_sessions?on_conflict=shop_domain", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      shop_domain: session.shop,
      access_token: session.accessToken,
      scope: session.scope || null,
      is_online: Boolean(session.isOnline),
      updated_at: new Date().toISOString(),
    }]),
  });
  return true;
}

export async function persistShopSettings(
  shopDomain: string,
  settings: { eurRate: number; plnRate: number; defaultQuantity: number; autoSync: boolean; syncIntervalMinutes?: number },
) {
  if (!hasSupabaseAdmin()) return false;
  await rest("parservo_settings?on_conflict=shop_domain", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      shop_domain: shopDomain,
      eur_rate: settings.eurRate,
      pln_rate: settings.plnRate,
      default_quantity: settings.defaultQuantity,
      auto_sync: settings.autoSync,
      sync_interval_minutes: settings.syncIntervalMinutes || 30,
      updated_at: new Date().toISOString(),
    }]),
  });
  return true;
}

export async function loadStoredSettings(shopDomain: string) {
  if (!hasSupabaseAdmin()) return null;
  const rows = await rest(`parservo_settings?shop_domain=eq.${encodeURIComponent(shopDomain)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function loadAutoSyncTargets(): Promise<StoredShopTarget[]> {
  if (!hasSupabaseAdmin()) return [];
  const select = "shop_domain,access_token,scope,parservo_settings!inner(eur_rate,pln_rate,default_quantity,auto_sync,sync_interval_minutes)";
  const rows = await rest(`parservo_shop_sessions?select=${encodeURIComponent(select)}&parservo_settings.auto_sync=eq.true`);
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const settings = Array.isArray(row.parservo_settings) ? row.parservo_settings[0] : row.parservo_settings;
    return {
      shop_domain: row.shop_domain,
      access_token: row.access_token,
      scope: row.scope || null,
      eur_rate: Number(settings?.eur_rate || 45),
      pln_rate: Number(settings?.pln_rate || 12.19),
      default_quantity: Number(settings?.default_quantity ?? 5),
      auto_sync: Boolean(settings?.auto_sync),
      sync_interval_minutes: Number(settings?.sync_interval_minutes || 30),
    };
  });
}

export async function createSyncRun(shopDomain: string, triggerType: string) {
  if (!hasSupabaseAdmin()) return null;
  const rows = await rest("parservo_sync_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{
      shop_domain: shopDomain,
      trigger_type: triggerType,
      status: "RUNNING",
    }]),
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function finishSyncRun(
  id: number | string | null | undefined,
  result: { status: string; total: number; success: number; failed: number; message?: string },
) {
  if (!id || !hasSupabaseAdmin()) return false;
  await rest(`parservo_sync_runs?id=eq.${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: result.status,
      total: result.total,
      success: result.success,
      failed: result.failed,
      message: result.message || null,
      finished_at: new Date().toISOString(),
    }),
  });
  return true;
}
