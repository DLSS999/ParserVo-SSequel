type GraphQLOptions = { variables?: Record<string, unknown> };

export type BackgroundAdminClient = {
  graphql: (query: string, options?: GraphQLOptions) => Promise<Response>;
};

type TokenResponse = {
  access_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function normalizeShopDomain(value: string) {
  const clean = value.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return clean.includes(".") ? clean : `${clean}.myshopify.com`;
}

export async function createBackgroundAdminClient(shopInput?: string): Promise<{
  shop: string;
  scope: string;
  expiresIn: number;
  admin: BackgroundAdminClient;
}> {
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  const shop = normalizeShopDomain(shopInput || process.env.SHOPIFY_SHOP_DOMAIN || "i5ahq3-6k.myshopify.com");

  if (!clientId || !clientSecret) {
    throw new Error("SHOPIFY_API_KEY or SHOPIFY_API_SECRET is missing.");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenData = await tokenResponse.json() as TokenResponse;

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || `Shopify token request failed: ${tokenResponse.status}`);
  }

  const accessToken = tokenData.access_token;
  const admin: BackgroundAdminClient = {
    graphql(query, options) {
      return fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: options?.variables || {} }),
      });
    },
  };

  return {
    shop,
    scope: tokenData.scope || "",
    expiresIn: Number(tokenData.expires_in || 0),
    admin,
  };
}
