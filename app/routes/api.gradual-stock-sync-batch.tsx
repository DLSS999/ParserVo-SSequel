import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncShopifyInventoryForProduct } from "../services/shopify-products.server";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number, max = 20) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.round(parsed)));
}

function parseQueueStartedAt(value: FormDataEntryValue | null) {
  const parsed = new Date(String(value || ""));
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    await authenticate.admin(request);
    return jsonResponse({
      ok: true,
      name: "ParserVo gradual stock sync batch API",
      message: "POST intent=sync_all_stock_batch to run one stock sync batch.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 401);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");

    if (intent !== "sync_all_stock_batch") {
      return jsonResponse({ ok: false, error: "Unsupported gradual stock sync intent." }, 400);
    }

    const stockBatchLimit = parsePositiveInt(formData.get("stockBatchLimit"), 8, 20);
    const queueStartedAt = parseQueueStartedAt(formData.get("startedAt"));
    const settings = await db.appSettings.findUnique({ where: { shop: session.shop } });

    const where: any = {
      shop: session.shop,
      shopifyProductGid: { not: null },
      syncEnabled: true,
      OR: [
        { lastSyncedAt: null },
        { lastSyncedAt: { lt: queueStartedAt } },
      ],
    };

    const remainingBefore = await db.importedProduct.count({ where });
    const productsToSync = await db.importedProduct.findMany({
      where,
      orderBy: [
        { lastSyncedAt: "asc" },
        { createdAt: "asc" },
      ],
      take: stockBatchLimit,
    });

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    let syncedVariants = 0;
    const errors: string[] = [];

    for (const product of productsToSync) {
      try {
        const result = await syncShopifyInventoryForProduct(admin, product.id, session.shop, {
          locationId: settings?.defaultShopifyLocationId || null,
          autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
          autoActivateAvailable: settings?.autoActivateAvailable ?? true,
        });

        if (result.skipped) {
          skipped += 1;

          await db.importedProduct.update({
            where: { id: product.id },
            data: { lastSyncedAt: new Date() },
          });

          await db.syncLog.create({
            data: {
              shop: session.shop,
              importedProductId: product.id,
              supplierName: product.supplierName,
              supplierUrl: product.supplierUrl,
              status: "gradual_shopify_inventory_sync_skipped",
              message: `Skipped during gradual stock sync: ${result.reason || "unknown reason"}`,
            },
          });
        } else {
          synced += 1;
          syncedVariants += Number(result.syncedVariants || 0);
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${product.originalTitle || product.title}: ${message}`);

        await db.importedProduct.update({
          where: { id: product.id },
          data: { lastSyncedAt: new Date() },
        });

        await db.syncLog.create({
          data: {
            shop: session.shop,
            importedProductId: product.id,
            supplierName: product.supplierName,
            supplierUrl: product.supplierUrl,
            status: "gradual_shopify_inventory_sync_error",
            message: `Failed during gradual Shopify inventory sync: ${message.slice(0, 450)}`,
            errorMessage: message,
          },
        });
      }
    }

    const remaining = await db.importedProduct.count({ where });

    return jsonResponse({
      ok: true,
      hasProductErrors: failed > 0,
      message: `Gradual stock sync batch finished. Processed: ${productsToSync.length}. Synced: ${synced}. Skipped: ${skipped}. Failed: ${failed}. Remaining: ${remaining}.`,
      errors: errors.slice(0, 20),
      batch: {
        startedAt: queueStartedAt.toISOString(),
        limit: stockBatchLimit,
        remainingBefore,
        processed: productsToSync.length,
        synced,
        skipped,
        failed,
        syncedVariants,
        remaining,
        done: remaining === 0 || productsToSync.length === 0,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
