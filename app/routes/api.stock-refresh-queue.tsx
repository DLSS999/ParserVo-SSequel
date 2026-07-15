import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import db from "../db.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-ParserVo-Token, Authorization, Access-Control-Request-Private-Network",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLimit(value: unknown) {
  const parsed = Number.parseInt(String(value || ""), 10);

  if (!Number.isFinite(parsed)) return 1000;

  return Math.max(1, Math.min(5000, parsed));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return jsonResponse({
    ok: true,
    name: "ParserVo Stock Refresh Queue API",
    message: "POST shop + token to receive imported Vitkac URLs for browser stock refresh.",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const rawBody = await request.text();
    const payload = JSON.parse(rawBody || "{}") as {
      shop?: string;
      token?: string;
      limit?: number | string;
      linkedOnly?: boolean;
    };

    const shop = normalizeString(payload.shop).toLowerCase();
    const token = normalizeString(payload.token);
    const limit = normalizeLimit(payload.limit);

    if (!shop || !token) {
      return jsonResponse({ ok: false, error: "Missing shop or browser capture token." }, 400);
    }

    const settings = await db.appSettings.findUnique({ where: { shop } });

    if (!settings || !settings.browserCaptureToken || settings.browserCaptureToken !== token) {
      return jsonResponse({ ok: false, error: "Invalid browser capture token for this shop." }, 401);
    }

    const products = await db.importedProduct.findMany({
      where: {
        shop,
        supplierName: "Vitkac",
        syncEnabled: true,
        supplierUrl: { contains: "vitkac.com" },
        ...(payload.linkedOnly ? { shopifyProductGid: { not: null } } : {}),
      },
      orderBy: [
        { lastSyncedAt: "asc" },
        { createdAt: "asc" },
      ],
      take: limit,
      select: {
        id: true,
        supplierUrl: true,
        supplierProductId: true,
        title: true,
        brand: true,
        shopifyProductGid: true,
        lastSyncedAt: true,
      },
    });

    return jsonResponse({
      ok: true,
      total: products.length,
      urls: products.map((product: any) => ({
        id: product.id,
        supplierUrl: product.supplierUrl,
        url: product.supplierUrl,
        supplierProductId: product.supplierProductId,
        title: product.title,
        brand: product.brand,
        linkedToShopify: Boolean(product.shopifyProductGid),
        lastSyncedAt: product.lastSyncedAt,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
