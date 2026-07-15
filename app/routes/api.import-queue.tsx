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
    name: "ParserVo Import Queue API",
    message: "POST shop + browser capture token to get queued Vitkac URLs for automatic browser capture.",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const rawBody = await request.text();
    let payload: {
      shop?: string;
      token?: string;
      limit?: number | string;
    };

    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON payload from Chrome extension." }, 400);
    }

    const shop = normalizeString(payload.shop).toLowerCase();
    const token = normalizeString(payload.token || request.headers.get("X-ParserVo-Token"));
    const limit = normalizeLimit(payload.limit);

    if (!shop || !token) {
      return jsonResponse({ ok: false, error: "Missing shop or browser capture token." }, 400);
    }

    const settings = await db.appSettings.findUnique({ where: { shop } });

    if (!settings || !settings.browserCaptureToken || settings.browserCaptureToken !== token) {
      return jsonResponse({ ok: false, error: "Invalid browser capture token for this shop." }, 401);
    }

    const queueItems = await db.importQueueItem.findMany({
      where: {
        shop,
        status: "queued",
        supplierUrl: {
          contains: "vitkac.com",
        },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    const urls = queueItems.map((item: any) => ({
      id: item.id,
      supplierUrl: item.supplierUrl,
      supplierProductId: item.supplierProductId,
      status: item.status,
    }));

    return jsonResponse({
      ok: true,
      count: urls.length,
      urls,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
