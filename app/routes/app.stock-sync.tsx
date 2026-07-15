import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  parseBooleanCell,
  parseNumberCell,
  parseSpreadsheetFile,
  pickColumn,
} from "../services/spreadsheet.server";
import { syncShopifyInventoryForProduct } from "../services/shopify-products.server";

const STOCK_SYNC_ACTIVE_KEY = "parservo_background_stock_sync_active";
const JOB_STATUSES = [
  "stock_background_running",
  "stock_background_completed",
  "stock_background_stopped",
  "stock_background_error",
];

function normalizeSize(value: string) {
  return String(value || "").trim().replace(",", ".");
}

function normalizeText(value: string) {
  return String(value || "").trim();
}

function formatDate(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

type BackgroundJobState = {
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

function defaultJobState(): BackgroundJobState {
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

function jobStatusFromLogStatus(status: string): BackgroundJobState["status"] {
  if (status === "stock_background_running") return "running";
  if (status === "stock_background_completed") return "completed";
  if (status === "stock_background_stopped") return "stopped";
  if (status === "stock_background_error") return "error";
  return "idle";
}

function stateFromLog(log: any | null): BackgroundJobState {
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

async function recalculateProductStock(productId: string) {
  const variants = await db.importedVariant.findMany({ where: { importedProductId: productId } });
  const availableSizes = variants.filter((variant: any) => variant.available).map((variant: any) => variant.size);
  const hasStock = availableSizes.length > 0;

  await db.importedProduct.update({
    where: { id: productId },
    data: {
      stockSourceStatus: hasStock ? "supplier_available" : "supplier_sold_out",
      status: hasStock ? "active" : "drafted_by_sync",
      lastSyncedAt: new Date(),
    },
  });

  return availableSizes;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const recentLogs = await db.syncLog.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const latestJob = await db.syncLog.findFirst({
    where: {
      shop: session.shop,
      OR: JOB_STATUSES.map((status) => ({ status })),
    },
    orderBy: { createdAt: "desc" },
  });

  const [
    totalProducts,
    linkedProducts,
    supplierAvailable,
    supplierSoldOut,
    syncEnabledProducts,
    neverSyncedLinkedProducts,
    failedLogsCount,
    lastSuccessfulSync,
    lastBrowserStockRefresh,
    browserRefreshLogsCount,
  ] = await Promise.all([
    db.importedProduct.count({ where: { shop: session.shop } }),
    db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null } } }),
    db.importedProduct.count({ where: { shop: session.shop, stockSourceStatus: "supplier_available" } }),
    db.importedProduct.count({ where: { shop: session.shop, stockSourceStatus: "supplier_sold_out" } }),
    db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null }, syncEnabled: true } }),
    db.importedProduct.count({
      where: {
        shop: session.shop,
        shopifyProductGid: { not: null },
        syncEnabled: true,
        lastSyncedAt: null,
      },
    }),
    db.syncLog.count({
      where: {
        shop: session.shop,
        OR: [
          { status: { contains: "inventory_sync_error" } },
          { status: { contains: "gradual_shopify_inventory_sync_error" } },
          { status: { contains: "stock_background_sync_error" } },
          { errorMessage: { not: null } },
        ],
      },
    }),
    db.syncLog.findFirst({
      where: {
        shop: session.shop,
        OR: [
          { status: "shopify_inventory_synced" },
          { status: "gradual_shopify_inventory_sync_done" },
          { status: "stock_background_completed" },
        ],
      },
      orderBy: { createdAt: "desc" },
    }),
    db.syncLog.findFirst({
      where: { shop: session.shop, status: "stock_browser_refreshed" },
      orderBy: { createdAt: "desc" },
    }),
    db.syncLog.count({ where: { shop: session.shop, status: "stock_browser_refreshed" } }),
  ]);

  return {
    recentLogs,
    totalProducts,
    linkedProducts,
    supplierAvailable,
    supplierSoldOut,
    syncEnabledProducts,
    neverSyncedLinkedProducts,
    failedLogsCount,
    lastSuccessfulSync,
    lastBrowserStockRefresh,
    browserRefreshLogsCount,
    backgroundJob: stateFromLog(latestJob),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const settings = await db.appSettings.findUnique({ where: { shop: session.shop } });

  if (intent === "clear_stock_error_logs") {
    const result = await db.syncLog.deleteMany({
      where: {
        shop: session.shop,
        OR: [
          { status: { contains: "inventory_sync_error" } },
          { status: { contains: "gradual_shopify_inventory_sync_error" } },
          { status: { contains: "stock_background_sync_error" } },
          { status: "stock_background_error" },
          { errorMessage: { not: null } },
        ],
      },
    });

    return { ok: true, message: `Очищены ошибочные логи синхронизации: ${result.count}.` };
  }

  if (intent !== "upload_stock") {
    return { ok: false, error: "Unknown action." };
  }

  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Загрузи Excel/CSV файл с остатками." };
  }

  const rows = await parseSpreadsheetFile(file);

  let updatedVariants = 0;
  let updatedProducts = 0;
  let missingProducts = 0;
  let missingVariants = 0;
  let invalidRows = 0;
  let shopifySynced = 0;
  let shopifySkipped = 0;
  let shopifyFailed = 0;

  const touchedProductIds = new Set<string>();
  const errors: string[] = [];

  for (const row of rows) {
    const supplierProductId = normalizeText(
      pickColumn(row, ["supplier_product_id", "product_id", "vitkac_id", "id"]),
    );
    const symbol = normalizeText(pickColumn(row, ["symbol", "supplier_symbol", "sku", "model_code"]));
    const size = normalizeSize(pickColumn(row, ["size", "розмір", "размер"]));
    const quantityCell = pickColumn(row, ["quantity", "qty", "stock", "inventory", "залишок", "остаток"]);
    const availableCell = pickColumn(row, ["available", "in_stock", "status", "availability", "наявність", "наличие"]);
    const priceCell = pickColumn(row, ["price", "supplier_price"]);

    if ((!supplierProductId && !symbol) || !size) {
      invalidRows += 1;
      continue;
    }

    const product = await db.importedProduct.findFirst({
      where: {
        shop: session.shop,
        OR: [
          ...(supplierProductId ? [{ supplierProductId }] : []),
          ...(symbol ? [{ supplierSymbol: symbol }, { modelCode: symbol }] : []),
        ],
      },
      include: { variants: true },
    });

    if (!product) {
      missingProducts += 1;
      errors.push(`Не найден товар: ${supplierProductId || symbol}`);
      continue;
    }

    const variant = product.variants.find(
      (item: any) => item.size === size || item.supplierSizeLabel === size || normalizeSize(item.size) === size,
    );

    if (!variant) {
      missingVariants += 1;
      errors.push(`Не найден размер ${size} для ${product.title}`);
      continue;
    }

    const quantity = quantityCell ? parseNumberCell(quantityCell, 0) : null;
    const available = quantity !== null ? quantity > 0 : parseBooleanCell(availableCell);
    const supplierPrice = priceCell ? parseNumberCell(priceCell, 0) : 0;

    await db.importedVariant.update({
      where: { id: variant.id },
      data: {
        lastAvailable: variant.available,
        available,
        ...(supplierPrice > 0 ? { price: supplierPrice } : {}),
      },
    });

    touchedProductIds.add(product.id);
    updatedVariants += 1;
  }

  for (const productId of touchedProductIds) {
    const availableSizes = await recalculateProductStock(productId);
    const product = await db.importedProduct.findUnique({ where: { id: productId } });

    await db.syncLog.create({
      data: {
        shop: session.shop,
        importedProductId: productId,
        supplierName: product?.supplierName || "Vitkac",
        supplierUrl: product?.supplierUrl || "",
        status: "stock_excel_sync",
        message: `Stock updated from Excel. Available sizes: ${availableSizes.join(", ") || "none"}`,
        newAvailableSizes: availableSizes.join(", "),
      },
    });

    updatedProducts += 1;

    if (product?.shopifyProductGid) {
      try {
        const result = await syncShopifyInventoryForProduct(admin, productId, session.shop, {
          locationId: settings?.defaultShopifyLocationId || null,
          autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
          autoActivateAvailable: settings?.autoActivateAvailable ?? true,
        });

        if (result.skipped) shopifySkipped += 1;
        else shopifySynced += 1;
      } catch (error) {
        shopifyFailed += 1;
        errors.push(`${product.title}: Shopify inventory error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (errors.length > 0) {
    await db.syncLog.create({
      data: {
        shop: session.shop,
        status: "stock_excel_sync_warning",
        message: `Stock sync completed with warnings. ${errors.slice(0, 10).join(" | ")}`,
        errorMessage: errors.slice(0, 30).join("\n"),
      },
    });
  }

  return {
    ok: errors.length === 0,
    message: `Stock Sync завершен. Обновлено вариантов: ${updatedVariants}. Товаров: ${updatedProducts}. Shopify synced: ${shopifySynced}. Shopify skipped: ${shopifySkipped}. Shopify failed: ${shopifyFailed}. Не найдено товаров: ${missingProducts}. Не найдено размеров: ${missingVariants}. Невалидных строк: ${invalidRows}.`,
    errors: errors.slice(0, 10),
  };
};

type ActionData = {
  ok?: boolean;
  message?: string;
  error?: string;
  errors?: string[];
};

type StockJobApiResponse = {
  ok?: boolean;
  error?: string;
  job?: BackgroundJobState;
};

async function readJsonResponse(response: Response) {
  const rawText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`API вернул не JSON (${response.status}): ${rawText.replace(/\s+/g, " ").slice(0, 260)}`);
  }
  return JSON.parse(rawText) as StockJobApiResponse;
}

export default function StockSync() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const isBusy = navigation.state !== "idle";

  const [stockBatchLimit, setStockBatchLimit] = useState("8");
  const [jobState, setJobState] = useState<BackgroundJobState>(data.backgroundJob || defaultJobState());
  const [jobError, setJobError] = useState("");
  const [isJobRequestBusy, setIsJobRequestBusy] = useState(false);

  const progress = useMemo(() => {
    const remaining = Number(jobState.remaining || 0);
    const total = jobState.processed + remaining;
    const percent = total > 0 ? Math.min(100, Math.round((jobState.processed / total) * 100)) : 0;
    return { total, percent };
  }, [jobState.processed, jobState.remaining]);

  const isJobRunning = jobState.status === "running";

  async function callStockJobApi(intent: "start" | "stop" | "status") {
    const formData = new FormData();
    formData.set("intent", intent);
    if (intent === "start") formData.set("batchSize", stockBatchLimit);

    const response = await fetch(`/api/stock-sync-job${window.location.search}`, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-Requested-With": "ParserVoStockSyncCenter",
      },
    });

    const data = await readJsonResponse(response);
    if (!response.ok || data.error) throw new Error(data.error || `Stock sync API error ${response.status}`);
    if (data.job) setJobState(data.job);
    return data;
  }

  async function startBackgroundStockSync() {
    if (isJobRequestBusy) return;
    setIsJobRequestBusy(true);
    setJobError("");
    try {
      const response = await callStockJobApi("start");
      if (response.job?.status === "running") {
        window.localStorage.setItem(STOCK_SYNC_ACTIVE_KEY, "1");
        window.dispatchEvent(new CustomEvent("parservo-stock-sync-started"));
      }
    } catch (error) {
      setJobError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsJobRequestBusy(false);
    }
  }

  async function stopBackgroundStockSync() {
    if (isJobRequestBusy) return;
    setIsJobRequestBusy(true);
    setJobError("");
    try {
      const response = await callStockJobApi("stop");
      window.localStorage.removeItem(STOCK_SYNC_ACTIVE_KEY);
      if (response.job) setJobState(response.job);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsJobRequestBusy(false);
    }
  }

  useEffect(() => {
    function onJobEvent(event: Event) {
      const detail = (event as CustomEvent<StockJobApiResponse>).detail;
      if (detail?.job) setJobState(detail.job);
      if (detail?.error) setJobError(detail.error);
    }

    window.addEventListener("parservo-stock-sync-job", onJobEvent);
    return () => window.removeEventListener("parservo-stock-sync-job", onJobEvent);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshStatus() {
      try {
        const data = await callStockJobApi("status");
        if (!cancelled && data.job) {
          setJobState(data.job);
          if (data.job.status !== "running") window.localStorage.removeItem(STOCK_SYNC_ACTIVE_KEY);
        }
      } catch (error) {
        if (!cancelled) setJobError(error instanceof Error ? error.message : String(error));
      }
    }

    const timer = window.setInterval(refreshStatus, 5000);
    refreshStatus();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="app-page app-page-wide stock-sync-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Stock Sync Center</h1>
          <p className="app-subtitle">Единая страница для наличия: расширение обновляет базу ParserVo, а ParserVo в фоне отправляет готовые остатки в Shopify.</p>
        </div>
        <div className="button-row">
          <Link className="btn" to="/app/products">Imported Products</Link>
          <Link className="btn" to="/app/logs">Sync Logs</Link>
        </div>
      </header>

      {actionData?.message ? (
        <div className={actionData.ok ? "notice notice-success" : "notice notice-warning"}>
          <strong>{actionData.message}</strong>
          {actionData.errors?.length ? (
            <pre className="small" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{actionData.errors.join("\n")}</pre>
          ) : null}
        </div>
      ) : null}

      {actionData?.error ? <div className="notice notice-error"><strong>{actionData.error}</strong></div> : null}
      {jobError ? <div className="notice notice-error"><strong>{jobError}</strong></div> : null}

      <section className="grid grid-4 compact-metrics">
        <div className="card">
          <div className="metric-label">Total products</div>
          <div className="metric-value">{data.totalProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Linked to Shopify</div>
          <div className="metric-value">{data.linkedProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Sync enabled</div>
          <div className="metric-value">{data.syncEnabledProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Supplier sold out</div>
          <div className="metric-value">{data.supplierSoldOut}</div>
        </div>
      </section>

      <section className="card section-gap">
        <h2 className="card-title">Правильный порядок работы</h2>
        <div className="sync-facts" style={{ marginTop: 8 }}>
          <span className="badge badge-green">1. Расширение Vitkac → Start stock refresh</span>
          <span className="badge badge-green">2. ParserVo база обновлена</span>
          <span className="badge badge-yellow">3. Start background push → остатки уйдут в Shopify</span>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          Если расширение уже прошло Vitkac и список в Imported Products обновился, заново парсить Vitkac не нужно.
          Запусти фоновую отправку ниже и можешь перейти на другие страницы ParserVo: процесс будет продолжаться, пока открыто приложение ParserVo.
        </p>
        <p className="muted small" style={{ marginTop: 6 }}>
          Последнее обновление базы через расширение: <strong>{formatDate(data.lastBrowserStockRefresh?.createdAt)}</strong> ·
          логов stock refresh: <strong>{data.browserRefreshLogsCount}</strong> · последний успешный пуш в Shopify: <strong>{formatDate(data.lastSuccessfulSync?.createdAt)}</strong>
        </p>
      </section>

      <section className="card section-gap sync-control-card">
        <div className="sync-control-grid">
          <div>
            <h2 className="card-title">Фоновая отправка остатков в Shopify</h2>
            <p className="muted small">
              Эта кнопка НЕ парсит Vitkac заново. Она берет уже обновленные остатки из базы ParserVo и отправляет их в Shopify маленькими партиями.
              Процесс не блокирует работу: можешь открыть Imported Products, Settings или Sync Logs, пока синхронизация идет.
            </p>
            <div className="sync-facts">
              <span className="badge badge-green">В наличии у поставщика: {data.supplierAvailable}</span>
              <span className="badge badge-yellow">Связано с Shopify и Sync enabled: {data.syncEnabledProducts}</span>
              <span className={data.failedLogsCount > 0 ? "badge badge-red" : "badge badge-green"}>Ошибочные логи: {data.failedLogsCount}</span>
              <span className="badge">Последний успех: {formatDate(data.lastSuccessfulSync?.createdAt)}</span>
            </div>
          </div>

          <div className="sync-actions-panel">
            <label className="inline-control">
              Batch size
              <select value={stockBatchLimit} onChange={(event) => setStockBatchLimit(event.currentTarget.value)} disabled={isJobRunning || isJobRequestBusy}>
                <option value="5">5 товаров</option>
                <option value="8">8 товаров</option>
                <option value="10">10 товаров</option>
              </select>
            </label>
            <button className="btn btn-primary" type="button" disabled={isJobRunning || isJobRequestBusy || data.linkedProducts === 0} onClick={startBackgroundStockSync}>
              {isJobRequestBusy ? "Запрос..." : isJobRunning ? "Background sync running" : "Start background push to Shopify"}
            </button>
            {isJobRunning ? (
              <button className="btn btn-danger" type="button" disabled={isJobRequestBusy} onClick={stopBackgroundStockSync}>Stop background sync</button>
            ) : null}
            <Link className="btn" to="/app/products">Continue working in Imported Products</Link>
          </div>
        </div>

        <div className={jobState.status === "error" || jobState.failed > 0 ? "notice notice-warning sync-progress-notice" : "notice notice-success sync-progress-notice"}>
          <strong>{jobState.message}</strong>
          {progress.total > 0 ? (
            <div className="progress-shell" aria-label="Stock sync progress">
              <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
            </div>
          ) : null}
          <div className="small sync-progress-line">
            Status: {jobState.status} · Processed: {jobState.processed} · Synced: {jobState.synced} · Variants: {jobState.syncedVariants} · Skipped: {jobState.skipped} · Failed: {jobState.failed}
            {jobState.remaining !== null ? <> · Remaining: {jobState.remaining}</> : null}
          </div>
          <div className="small sync-progress-line">
            Started: {formatDate(jobState.startedAt)} · Updated: {formatDate(jobState.updatedAt)} · Finished: {formatDate(jobState.finishedAt)}
          </div>
          {jobState.lastError ? <pre className="small sync-error-box">{jobState.lastError}</pre> : null}
        </div>
      </section>

      <section className="grid grid-2 section-gap stock-secondary-grid">
        <div className="card">
          <h2 className="card-title">Excel / CSV обновление остатков</h2>
          <p className="muted small">
            Используй только если у тебя есть отдельный файл с остатками. Для обычной синхронизации Shopify нажимай большую кнопку выше.
          </p>

          <Form method="post" encType="multipart/form-data" className="form-stack" style={{ marginTop: 12 }}>
            <input type="hidden" name="intent" value="upload_stock" />
            <input name="file" type="file" accept=".xlsx,.xls,.csv" />
            <button className="btn" type="submit" disabled={isBusy}>
              {isBusy ? "Syncing..." : "Upload Excel and sync"}
            </button>
          </Form>
        </div>

        <div className="card">
          <h2 className="card-title">Обслуживание логов</h2>
          <p className="muted small">
            Если старые ошибки уже не актуальны, очисти только ошибочные stock-логи. Успешные логи и товары не удаляются.
          </p>
          <Form method="post" style={{ marginTop: 12 }}>
            <input type="hidden" name="intent" value="clear_stock_error_logs" />
            <button className="btn btn-danger" type="submit" disabled={isBusy || data.failedLogsCount === 0}>
              Clear stock error logs
            </button>
          </Form>
        </div>
      </section>

      <section className="card section-gap">
        <h2 className="card-title">Recent Sync Logs</h2>
        {data.recentLogs.length === 0 ? (
          <p className="muted">No logs yet.</p>
        ) : (
          <div className="table-wrap stock-logs-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Message</th>
                  <th>Error detail</th>
                </tr>
              </thead>
              <tbody>
                {data.recentLogs.map((log: any) => (
                  <tr key={log.id}>
                    <td>{formatDate(log.createdAt)}</td>
                    <td>{log.status}</td>
                    <td>{log.message || "—"}</td>
                    <td className="error-detail-cell">{log.errorMessage && !String(log.errorMessage).trim().startsWith("{") ? log.errorMessage : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
