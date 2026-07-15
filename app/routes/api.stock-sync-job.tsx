import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncShopifyInventoryForProduct } from "../services/shopify-products.server";

const RUNNING_STATUS = "stock_background_running";
const COMPLETED_STATUS = "stock_background_completed";
const STOPPED_STATUS = "stock_background_stopped";
const ERROR_STATUS = "stock_background_error";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function parsePositiveInt(value: FormDataEntryValue | string | null | undefined, fallback: number, max = 20) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.round(parsed)));
}

type JobState = {
  id?: string;
  status: "running" | "completed" | "stopped" | "error" | "idle";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  batchSize: number;
  processed: number;
  synced: number;
  skipped: number;
  failed: number;
  syncedVariants: number;
  remaining: number | null;
  lastError?: string | null;
  message: string;
};

function defaultJobState(): JobState {
  return {
    status: "idle",
    startedAt: "",
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    batchSize: 8,
    processed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    syncedVariants: 0,
    remaining: null,
    lastError: null,
    message: "Фоновая синхронизация не запущена.",
  };
}

function safeJsonParse(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jobStatusFromLogStatus(status: string): JobState["status"] {
  if (status === RUNNING_STATUS) return "running";
  if (status === COMPLETED_STATUS) return "completed";
  if (status === STOPPED_STATUS) return "stopped";
  if (status === ERROR_STATUS) return "error";
  return "idle";
}

function stateFromLog(log: any | null): JobState {
  if (!log) return defaultJobState();
  const parsed = safeJsonParse(log.errorMessage) || {};
  return {
    ...defaultJobState(),
    ...parsed,
    id: log.id,
    status: jobStatusFromLogStatus(log.status),
    updatedAt: parsed.updatedAt || (log.finishedAt ? new Date(log.finishedAt).toISOString() : new Date(log.createdAt).toISOString()),
    message: log.message || parsed.message || defaultJobState().message,
  };
}

async function getLatestJob(shop: string) {
  return db.syncLog.findFirst({
    where: {
      shop,
      OR: [
        { status: RUNNING_STATUS },
        { status: COMPLETED_STATUS },
        { status: STOPPED_STATUS },
        { status: ERROR_STATUS },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

async function getRunningJob(shop: string) {
  return db.syncLog.findFirst({
    where: { shop, status: RUNNING_STATUS },
    orderBy: { createdAt: "desc" },
  });
}

function serializeJobState(job: JobState) {
  return JSON.stringify({
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || null,
    batchSize: job.batchSize,
    processed: job.processed,
    synced: job.synced,
    skipped: job.skipped,
    failed: job.failed,
    syncedVariants: job.syncedVariants,
    remaining: job.remaining,
    lastError: job.lastError || null,
    message: job.message,
  });
}

async function saveJob(logId: string, status: string, job: JobState) {
  const now = new Date();
  const finished = status === COMPLETED_STATUS || status === STOPPED_STATUS || status === ERROR_STATUS;
  const saved = await db.syncLog.update({
    where: { id: logId },
    data: {
      status,
      message: job.message,
      errorMessage: serializeJobState(job),
      finishedAt: finished ? now : null,
    },
  });
  return stateFromLog(saved);
}

async function countRemaining(shop: string, startedAt: Date) {
  return db.importedProduct.count({
    where: {
      shop,
      shopifyProductGid: { not: null },
      syncEnabled: true,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: startedAt } }],
    },
  });
}

async function startJob(shop: string, batchSize: number) {
  const running = await getRunningJob(shop);
  if (running) return stateFromLog(running);

  const startedAt = new Date();
  const remaining = await countRemaining(shop, startedAt);
  const initialState: JobState = {
    status: "running",
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    finishedAt: null,
    batchSize,
    processed: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    syncedVariants: 0,
    remaining,
    lastError: null,
    message: `Фоновая синхронизация запущена. Партия: ${batchSize}. Осталось товаров: ${remaining}. Можно перейти на другие страницы ParserVo.`,
  };

  const log = await db.syncLog.create({
    data: {
      shop,
      status: RUNNING_STATUS,
      message: initialState.message,
      errorMessage: serializeJobState(initialState),
      startedAt,
    },
  });

  return { ...initialState, id: log.id };
}

async function stopJob(shop: string) {
  const running = await getRunningJob(shop);
  if (!running) return stateFromLog(await getLatestJob(shop));
  const current = stateFromLog(running);
  const next: JobState = {
    ...current,
    status: "stopped",
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    message: `Фоновая синхронизация остановлена. Обработано: ${current.processed}. Осталось: ${current.remaining ?? "—"}.`,
  };
  return saveJob(running.id, STOPPED_STATUS, next);
}

async function tickJob(admin: any, shop: string) {
  const running = await getRunningJob(shop);
  if (!running) return stateFromLog(await getLatestJob(shop));

  const settings = await db.appSettings.findUnique({ where: { shop } });
  const current = stateFromLog(running);
  const batchSize = parsePositiveInt(String(current.batchSize), 8, 20);
  const startedAt = new Date(current.startedAt || running.startedAt || running.createdAt);

  try {
    const where: any = {
      shop,
      shopifyProductGid: { not: null },
      syncEnabled: true,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: startedAt } }],
    };

    const remainingBefore = await db.importedProduct.count({ where });
    const productsToSync = await db.importedProduct.findMany({
      where,
      orderBy: [{ lastSyncedAt: "asc" }, { createdAt: "asc" }],
      take: batchSize,
    });

    if (productsToSync.length === 0 || remainingBefore === 0) {
      const completed: JobState = {
        ...current,
        status: "completed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        remaining: 0,
        message: `Фоновая синхронизация завершена. Обработано: ${current.processed}. Успешно: ${current.synced}. Ошибок: ${current.failed}.`,
      };
      return saveJob(running.id, COMPLETED_STATUS, completed);
    }

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    let syncedVariants = 0;
    const errors: string[] = [];

    for (const product of productsToSync) {
      try {
        const result = await syncShopifyInventoryForProduct(admin, product.id, shop, {
          locationId: settings?.defaultShopifyLocationId || null,
          autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
          autoActivateAvailable: settings?.autoActivateAvailable ?? true,
        });

        if (result.skipped) {
          skipped += 1;
          await db.importedProduct.update({ where: { id: product.id }, data: { lastSyncedAt: new Date() } });
          await db.syncLog.create({
            data: {
              shop,
              importedProductId: product.id,
              supplierName: product.supplierName,
              supplierUrl: product.supplierUrl,
              status: "stock_background_sync_skipped",
              message: `Skipped during background stock sync: ${result.reason || "unknown reason"}`,
            },
          });
        } else {
          synced += 1;
          syncedVariants += Number(result.syncedVariants || 0);
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        const title = product.originalTitle || product.title;
        errors.push(`${title}: ${message}`);

        await db.importedProduct.update({ where: { id: product.id }, data: { lastSyncedAt: new Date() } });
        await db.syncLog.create({
          data: {
            shop,
            importedProductId: product.id,
            supplierName: product.supplierName,
            supplierUrl: product.supplierUrl,
            status: "stock_background_sync_error",
            message: `Failed during background stock sync: ${message.slice(0, 450)}`,
            errorMessage: message,
          },
        });
      }
    }

    const remaining = await countRemaining(shop, startedAt);
    const processedTotal = current.processed + productsToSync.length;
    const next: JobState = {
      ...current,
      status: remaining <= 0 ? "completed" : "running",
      updatedAt: new Date().toISOString(),
      finishedAt: remaining <= 0 ? new Date().toISOString() : null,
      processed: processedTotal,
      synced: current.synced + synced,
      skipped: current.skipped + skipped,
      failed: current.failed + failed,
      syncedVariants: current.syncedVariants + syncedVariants,
      remaining,
      lastError: errors.length ? errors.slice(-3).join("\n") : current.lastError || null,
      message:
        remaining <= 0
          ? `Фоновая синхронизация завершена. Обработано: ${processedTotal}. Успешно: ${current.synced + synced}. Ошибок: ${current.failed + failed}.`
          : `Фоновая синхронизация идет. Обработано: ${processedTotal}. Осталось: ${remaining}. Последняя партия: ${productsToSync.length}.`,
    };

    return saveJob(running.id, remaining <= 0 ? COMPLETED_STATUS : RUNNING_STATUS, next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errored: JobState = {
      ...current,
      status: "error",
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastError: message,
      message: `Фоновая синхронизация остановлена из-за ошибки: ${message}`,
    };
    return saveJob(running.id, ERROR_STATUS, errored);
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const latest = await getLatestJob(session.shop);
    return jsonResponse({ ok: true, job: stateFromLog(latest) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 401);
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "status");

    if (intent === "status") {
      const latest = await getLatestJob(session.shop);
      return jsonResponse({ ok: true, job: stateFromLog(latest) });
    }

    if (intent === "start") {
      const batchSize = parsePositiveInt(formData.get("batchSize"), 8, 20);
      const job = await startJob(session.shop, batchSize);
      return jsonResponse({ ok: true, job });
    }

    if (intent === "stop") {
      const job = await stopJob(session.shop);
      return jsonResponse({ ok: true, job });
    }

    if (intent === "tick") {
      const job = await tickJob(admin, session.shop);
      return jsonResponse({ ok: true, job });
    }

    return jsonResponse({ ok: false, error: "Unsupported stock sync job intent." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
