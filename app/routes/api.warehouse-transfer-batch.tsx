import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { transferInventoryByShopifyTagBatch } from "../services/shopify-products.server";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function parseBatchSize(value: FormDataEntryValue | null) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.max(1, Math.min(25, Math.round(parsed)));
}

function asText(value: FormDataEntryValue | null) {
  return String(value || "").trim();
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  try {
    const result = await transferInventoryByShopifyTagBatch(admin, {
      tag: asText(formData.get("tag")),
      sourceLocationId: asText(formData.get("sourceLocationId")),
      destinationLocationId: asText(formData.get("destinationLocationId")),
      cursor: asText(formData.get("cursor")) || null,
      batchSize: parseBatchSize(formData.get("batchSize")),
      dryRun: asText(formData.get("dryRun")) === "1",
      mode: asText(formData.get("mode")) === "replace" ? "replace" : "add",
    });

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Unknown warehouse transfer error");
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
