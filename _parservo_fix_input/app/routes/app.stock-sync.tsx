import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  parseBooleanCell,
  parseNumberCell,
  parseSpreadsheetFile,
  pickColumn,
} from "../services/spreadsheet.server";
import {
  syncLinkedProductsInventory,
  syncShopifyInventoryForProduct,
} from "../services/shopify-products.server";

function normalizeSize(value: string) {
  return String(value || "").trim().replace(",", ".");
}

function normalizeText(value: string) {
  return String(value || "").trim();
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
    take: 30,
  });

  const [totalProducts, linkedProducts, supplierAvailable, supplierSoldOut, syncEnabledProducts] = await Promise.all([
    db.importedProduct.count({ where: { shop: session.shop } }),
    db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null } } }),
    db.importedProduct.count({ where: { shop: session.shop, stockSourceStatus: "supplier_available" } }),
    db.importedProduct.count({ where: { shop: session.shop, stockSourceStatus: "supplier_sold_out" } }),
    db.importedProduct.count({ where: { shop: session.shop, syncEnabled: true } }),
  ]);

  return { recentLogs, totalProducts, linkedProducts, supplierAvailable, supplierSoldOut, syncEnabledProducts };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const settings = await db.appSettings.findUnique({ where: { shop: session.shop } });

  if (intent === "sync_shopify_inventory_all") {
    const result = await syncLinkedProductsInventory(admin, session.shop, {
      limit: 100,
      locationId: settings?.defaultShopifyLocationId || null,
      autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
      autoActivateAvailable: settings?.autoActivateAvailable ?? true,
    });

    return {
      ok: result.failed === 0,
      message: `Shopify inventory sync finished. Total: ${result.total}. Synced: ${result.synced}. Skipped: ${result.skipped}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 10),
    };
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

export default function StockSync() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const isBusy = navigation.state !== "idle";

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Stock Sync</h1>
          <p className="app-subtitle">Отдельный контроль наличия: Excel/CSV, база приложения и синхронизация остатков в Shopify.</p>
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

      <section className="grid grid-4">
        <div className="card">
          <div className="metric-label">Total products</div>
          <div className="metric-value">{data.totalProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Linked to Shopify</div>
          <div className="metric-value">{data.linkedProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Supplier available</div>
          <div className="metric-value">{data.supplierAvailable}</div>
        </div>
        <div className="card">
          <div className="metric-label">Supplier sold out</div>
          <div className="metric-value">{data.supplierSoldOut}</div>
        </div>
      </section>

      <section className="grid grid-2 section-gap">
        <div className="card">
          <h2 className="card-title">1. Upload stock Excel / CSV</h2>
          <p className="muted small">
            Поддерживаемые колонки: supplier_product_id или symbol, size, quantity или available, price.
            После загрузки приложение обновит свою базу и сразу синхронизирует Shopify inventory для товаров, которые уже созданы в Shopify.
          </p>

          <Form method="post" encType="multipart/form-data" className="form-stack" style={{ marginTop: 12 }}>
            <input type="hidden" name="intent" value="upload_stock" />
            <input name="file" type="file" accept=".xlsx,.xls,.csv" />
            <button className="btn btn-primary" type="submit" disabled={isBusy}>
              {isBusy ? "Syncing..." : "Upload and sync stock"}
            </button>
          </Form>
        </div>

        <div className="card">
          <h2 className="card-title">2. Push current app stock to Shopify</h2>
          <p className="muted small">
            Используй эту кнопку, если наличие уже правильное в Imported Products и нужно просто обновить Shopify.
            Если включены настройки Auto Draft Sold Out / Auto Activate Available, приложение также будет менять статус товара.
          </p>

          <Form method="post" style={{ marginTop: 12 }}>
            <input type="hidden" name="intent" value="sync_shopify_inventory_all" />
            <button className="btn" type="submit" disabled={isBusy || data.linkedProducts === 0}>
              {isBusy ? "Working..." : "Sync Shopify inventory for linked products"}
            </button>
          </Form>
        </div>
      </section>

      <section className="card section-gap">
        <h2 className="card-title">Формат файла</h2>
        <pre style={{ whiteSpace: "pre-wrap" }}>{`supplier_product_id,symbol,size,quantity,available,price,currency
1810796,DR3250YMX558-0-BLK,0,1,true,2368,PLN
1810796,DR3250YMX558-0-BLK,2,0,false,2368,PLN
1665725,755341 AACG0-1000,35,1,true,5069,PLN`}</pre>
      </section>

      <section className="card section-gap">
        <h2 className="card-title">Recent Sync Logs</h2>
        {data.recentLogs.length === 0 ? (
          <p className="muted">No logs yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {data.recentLogs.map((log: any) => (
                  <tr key={log.id}>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                    <td>{log.status}</td>
                    <td>{log.message || log.errorMessage || "—"}</td>
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
