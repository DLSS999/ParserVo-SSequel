const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

type StoredSession = {
  shop_domain: string;
  access_token: string;
  scope?: string | null;
};

export type StoredAdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

function databaseConfig() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY is not configured in Vercel.");
  return { url, key };
}

function databaseHeaders(key: string) {
  const headers: Record<string, string> = {
    apikey: key,
    Accept: "application/json",
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function loadStoredSession(shopDomain: string): Promise<StoredSession> {
  const { url, key } = databaseConfig();
  const endpoint = `${url}/rest/v1/parservo_shop_sessions?shop_domain=eq.${encodeURIComponent(shopDomain)}&select=shop_domain,access_token,scope&limit=1`;
  const response = await fetch(endpoint, {
    headers: databaseHeaders(key),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Stored Shopify session ${response.status}: ${text.slice(0, 500)}`);
  const rows = JSON.parse(text || "[]") as StoredSession[];
  if (!rows[0]?.access_token) {
    throw new Error("Shopify offline session is not stored. Open ParserVo in Shopify once and retry.");
  }
  return rows[0];
}

export async function createStoredAdminClient(shopDomain: string): Promise<StoredAdminClient> {
  const session = await loadStoredSession(shopDomain);
  return {
    graphql(query, options) {
      return fetch(`https://${session.shop_domain}/admin/api/2026-04/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.access_token,
        },
        body: JSON.stringify({
          query,
          variables: options?.variables || {},
        }),
      });
    },
  };
}
