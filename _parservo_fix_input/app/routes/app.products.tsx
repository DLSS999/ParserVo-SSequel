import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { statusBadgeClass } from "../services/status";
import {
  cleanupImportedProductsDeletedInShopify,
  createImportedProductsInShopify,
  createShopifyProductFromImported,
  deleteImportedProductsAndShopify,
  deleteShopifyProductAndImported,
  syncShopifyInventoryForProduct,
  syncCategoryMetafieldsForImportedProduct,
  syncCategoryMetafieldsForImportedProducts,
} from "../services/shopify-products.server";

const ALPHA_SIZE_ORDER = ["XXXXS", "XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL"];

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number, max = 500) {
  const parsed = Number(String(value || "").replace(/[^0-9]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.round(parsed)));
}

function getSelectedIds(formData: FormData) {
  return Array.from(new Set(formData.getAll("selectedProductIds").map((value) => String(value)).filter(Boolean)));
}

function sizeSortKey(value: string) {
  const normalized = normalizeString(value).replace(",", ".").toUpperCase();
  const numeric = Number(normalized.replace(/[^0-9.]/g, ""));

  if (/^\d+(?:\.\d+)?$/.test(normalized) && Number.isFinite(numeric)) {
    return { group: 1, rank: numeric, label: normalized };
  }

  const alphaRank = ALPHA_SIZE_ORDER.indexOf(normalized);
  if (alphaRank >= 0) return { group: 2, rank: alphaRank, label: normalized };

  return { group: 3, rank: 9999, label: normalized };
}

function compareSizes(a: string, b: string) {
  const left = sizeSortKey(a);
  const right = sizeSortKey(b);

  if (left.group !== right.group) return left.group - right.group;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.label.localeCompare(right.label, "uk");
}

function sortVariants(variants: any[]) {
  return [...(variants || [])].sort((a, b) => compareSizes(a.size || a.supplierSizeLabel || "", b.size || b.supplierSizeLabel || ""));
}

function displayTitle(product: any) {
  return product.originalTitle || product.title || "Untitled product";
}

function transferMessage(result: { total: number; created: number; skipped: number; failed: number }) {
  return `Shopify transfer finished. Total: ${result.total}. Created: ${result.created}. Skipped: ${result.skipped}. Failed: ${result.failed}.`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const cleanup = await cleanupImportedProductsDeletedInShopify(admin, session.shop);

  const [products, stats, settings] = await Promise.all([
    db.importedProduct.findMany({
      where: { shop: session.shop },
      include: { variants: true },
      orderBy: { createdAt: "desc" },
    }),
    Promise.all([
      db.importedProduct.count({ where: { shop: session.shop } }),
      db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: null } }),
      db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null } } }),
      db.importedProduct.count({ where: { shop: session.shop, stockSourceStatus: "supplier_sold_out" } }),
    ]),
    db.appSettings.findUnique({ where: { shop: session.shop } }),
  ]);

  return {
    products,
    settings,
    cleanup,
    stats: {
      total: stats[0],
      notCreated: stats[1],
      created: stats[2],
      soldOut: stats[3],
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") || "");
  const rowAction = String(formData.get("rowAction") || "");
  const selectedIds = getSelectedIds(formData);
  const batchLimit = parsePositiveInt(formData.get("batchLimit"), 20, 500);
  const settings = await db.appSettings.findUnique({ where: { shop: session.shop } });

  if (intent === "create_selected_draft" || intent === "create_selected_active") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери товары галочками перед переносом." };
    const status = intent === "create_selected_active" ? "ACTIVE" : "DRAFT";
    const result = await createImportedProductsInShopify(admin, session.shop, {
      productIds: selectedIds,
      status,
      locationId: settings?.defaultShopifyLocationId || null,
    });

    return { ok: result.failed === 0, message: transferMessage(result), errors: result.errors.slice(0, 20) };
  }

  if (intent === "create_batch_draft" || intent === "create_batch_active") {
    const status = intent === "create_batch_active" ? "ACTIVE" : "DRAFT";
    const result = await createImportedProductsInShopify(admin, session.shop, {
      limit: batchLimit,
      status,
      locationId: settings?.defaultShopifyLocationId || null,
    });

    return { ok: result.failed === 0, message: transferMessage(result), errors: result.errors.slice(0, 20) };
  }

  if (intent === "create_all_draft" || intent === "create_all_active") {
    const status = intent === "create_all_active" ? "ACTIVE" : "DRAFT";
    const result = await createImportedProductsInShopify(admin, session.shop, {
      allNotCreated: true,
      status,
      locationId: settings?.defaultShopifyLocationId || null,
    });

    return { ok: result.failed === 0, message: transferMessage(result), errors: result.errors.slice(0, 20) };
  }

  if (intent === "delete_selected") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери товары галочками перед удалением." };
    const result = await deleteImportedProductsAndShopify(admin, session.shop, selectedIds);

    return {
      ok: result.failed === 0,
      message: `Deleted selected. Total: ${result.total}. From Shopify: ${result.deletedFromShopify}. From app: ${result.deletedFromApp}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "sync_selected_category_meta") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери уже созданные товары галочками." };
    const result = await syncCategoryMetafieldsForImportedProducts(admin, session.shop, selectedIds);
    return {
      ok: result.failed === 0,
      message: `Category metafields synced. Total: ${result.total}. Synced products: ${result.synced}. Failed: ${result.failed}.`,
      errors: result.errors.slice(0, 20),
    };
  }

  if (intent === "enable_selected_sync" || intent === "disable_selected_sync") {
    if (selectedIds.length === 0) return { ok: false, error: "Выбери товары галочками." };
    const enabled = intent === "enable_selected_sync";
    const result = await db.importedProduct.updateMany({
      where: { shop: session.shop, id: { in: selectedIds } },
      data: { syncEnabled: enabled },
    });
    return { ok: true, message: `${enabled ? "Enabled" : "Disabled"} sync for ${result.count} products.` };
  }

  if (rowAction) {
    const [action, productId] = rowAction.split(":");
    if (!productId) return { ok: false, error: "Product ID is missing." };

    const product = await db.importedProduct.findFirst({ where: { id: productId, shop: session.shop } });
    if (!product) return { ok: false, error: "Product not found." };

    if (action === "disable_sync" || action === "enable_sync") {
      const enabled = action === "enable_sync";
      await db.importedProduct.update({
        where: { id: product.id },
        data: { syncEnabled: enabled, status: enabled ? (product.shopifyProductGid ? "active" : "imported") : "manual_disabled" },
      });
      return { ok: true, message: `${enabled ? "Enabled" : "Disabled"} sync for ${displayTitle(product)}.` };
    }

    if (action === "delete_product") {
      const result = await deleteShopifyProductAndImported(admin, product.id, session.shop);
      return {
        ok: true,
        message: result.deletedFromShopify
          ? `Deleted from Shopify and app: ${result.title}`
          : `Deleted from app: ${result.title}`,
      };
    }

    if (action === "create_shopify_draft" || action === "create_shopify_active") {
      const status = action === "create_shopify_active" ? "ACTIVE" : "DRAFT";
      const result = await createShopifyProductFromImported(admin, product.id, session.shop, {
        status,
        locationId: settings?.defaultShopifyLocationId || null,
      });

      return {
        ok: true,
        message: result.skipped
          ? "Товар уже был создан в Shopify."
          : `Товар создан в Shopify как ${status === "ACTIVE" ? "Active" : "Draft"}: ${result.productTitle}`,
      };
    }

    if (action === "sync_category_meta") {
      const result = await syncCategoryMetafieldsForImportedProduct(admin, product.id, session.shop);
      return {
        ok: result.synced > 0,
        message: `Category metafields sync. Attempted: ${result.attempted}. Synced: ${result.synced}. Skipped: ${result.skipped}.`,
        errors: result.errors.slice(0, 20),
      };
    }

    if (action === "sync_now") {
      const result = await syncShopifyInventoryForProduct(admin, product.id, session.shop, {
        locationId: settings?.defaultShopifyLocationId || null,
        autoDraftSoldOut: settings?.autoDraftSoldOut ?? true,
        autoActivateAvailable: settings?.autoActivateAvailable ?? true,
      });

      return {
        ok: !result.skipped,
        message: result.skipped
          ? `Inventory sync skipped: ${result.reason}`
          : `Inventory synced. Variants: ${result.syncedVariants}. Available sizes: ${result.availableSizes.join(", ") || "none"}`,
      };
    }
  }

  return { ok: true };
};

type ActionData = {
  ok?: boolean;
  message?: string;
  error?: string;
  errors?: string[];
};

export default function ImportedProducts() {
  const { products, stats, cleanup } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const isBusy = navigation.state !== "idle";

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Imported Products</h1>
          <p className="app-subtitle">Импортированные товары, перенос в Shopify, выборка галочками и контроль синхронизации наличия.</p>
        </div>
        <div className="button-row">
          <Link className="btn" to="/app/import">Import product</Link>
          <Link className="btn" to="/app/excel-import">Excel import</Link>
          <Link className="btn" to="/app/stock-sync">Stock sync</Link>
        </div>
      </header>

      {cleanup?.removed ? (
        <div className="notice notice-success">
          В Shopify были удалены товары, поэтому ParserVo автоматически убрал из базы приложения: {cleanup.removed}.
        </div>
      ) : null}

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
          <div className="metric-label">Imported in app</div>
          <div className="metric-value">{stats.total}</div>
        </div>
        <div className="card">
          <div className="metric-label">Not created in Shopify</div>
          <div className="metric-value">{stats.notCreated}</div>
        </div>
        <div className="card">
          <div className="metric-label">Created in Shopify</div>
          <div className="metric-value">{stats.created}</div>
        </div>
        <div className="card">
          <div className="metric-label">Supplier sold out</div>
          <div className="metric-value">{stats.soldOut}</div>
        </div>
      </section>

      {products.length === 0 ? (
        <section className="card section-gap">
          <h2 className="card-title">No imported products yet</h2>
          <p className="muted">Сначала загрузи Excel и выкачай товары через расширение.</p>
          <Link className="btn btn-primary" to="/app/excel-import">Excel import</Link>
        </section>
      ) : (
        <Form method="post">
          <section className="card section-gap">
            <h2 className="card-title">Bulk transfer to Shopify</h2>
            <p className="muted small">
              Теперь можно выгружать выбранные товары, следующую партию любого размера или все товары, которые еще не созданы в Shopify.
            </p>
            <div className="button-row" style={{ marginTop: 12, alignItems: "center" }}>
              <button
                className="btn"
                type="button"
                onClick={() => document.querySelectorAll<HTMLInputElement>('input[name="selectedProductIds"]').forEach((input) => { input.checked = true; })}
              >
                Select all visible
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => document.querySelectorAll<HTMLInputElement>('input[name="selectedProductIds"]').forEach((input) => { input.checked = false; })}
              >
                Clear selection
              </button>
              <button className="btn btn-primary" type="submit" name="intent" value="create_selected_draft" disabled={isBusy}>Create selected Draft</button>
              <button
                className="btn"
                type="submit"
                name="intent"
                value="create_selected_active"
                disabled={isBusy}
                onClick={(event) => {
                  if (!confirm("Создать выбранные товары сразу Active в Shopify?")) event.preventDefault();
                }}
              >
                Create selected Active
              </button>
              <button
                className="btn btn-danger"
                type="submit"
                name="intent"
                value="delete_selected"
                disabled={isBusy}
                onClick={(event) => {
                  if (!confirm("Удалить выбранные товары из приложения и Shopify, если они уже созданы?")) event.preventDefault();
                }}
              >
                Delete selected
              </button>
            </div>
            <div className="button-row" style={{ marginTop: 12, alignItems: "center" }}>
              <label className="small muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Batch size
                <input name="batchLimit" type="number" min="1" max="500" defaultValue="50" style={{ width: 90 }} />
              </label>
              <button className="btn btn-primary" type="submit" name="intent" value="create_batch_draft" disabled={isBusy || stats.notCreated === 0}>Create next batch Draft</button>
              <button
                className="btn"
                type="submit"
                name="intent"
                value="create_batch_active"
                disabled={isBusy || stats.notCreated === 0}
                onClick={(event) => {
                  if (!confirm("Создать следующую партию товаров сразу Active?")) event.preventDefault();
                }}
              >
                Create next batch Active
              </button>
              <button className="btn" type="submit" name="intent" value="create_all_draft" disabled={isBusy || stats.notCreated === 0}>Create ALL not-created Draft</button>
              <button
                className="btn"
                type="submit"
                name="intent"
                value="create_all_active"
                disabled={isBusy || stats.notCreated === 0}
                onClick={(event) => {
                  if (!confirm("Создать ВСЕ не созданные товары сразу Active?")) event.preventDefault();
                }}
              >
                Create ALL not-created Active
              </button>
            </div>
            <div className="button-row" style={{ marginTop: 12 }}>
              <button className="btn" type="submit" name="intent" value="enable_selected_sync" disabled={isBusy}>Enable selected sync</button>
              <button className="btn" type="submit" name="intent" value="disable_selected_sync" disabled={isBusy}>Disable selected sync</button>
              <button className="btn" type="submit" name="intent" value="sync_selected_category_meta" disabled={isBusy}>Sync selected category metafields</button>
            </div>
          </section>

          <section className="card section-gap">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Image</th>
                    <th>Brand</th>
                    <th>Title</th>
                    <th>Supplier</th>
                    <th>Cost</th>
                    <th>Sale</th>
                    <th>Available sizes</th>
                    <th>Shopify</th>
                    <th>Status</th>
                    <th>Stock</th>
                    <th>Sync</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product: any) => {
                    const sortedVariants = sortVariants(product.variants);
                    const availableSizes = sortedVariants
                      .filter((variant: any) => variant.available)
                      .map((variant: any) => variant.size)
                      .join(", ");

                    const shopifyAdminUrl = product.shopifyProductId
                      ? `https://admin.shopify.com/store/${product.shop.replace(".myshopify.com", "")}/products/${product.shopifyProductId}`
                      : "";

                    return (
                      <tr key={product.id}>
                        <td>
                          <input type="checkbox" name="selectedProductIds" value={product.id} />
                        </td>
                        <td>
                          {product.imageUrl ? (
                            <img className="product-image" src={product.imageUrl} alt={displayTitle(product)} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{product.brand || "—"}</td>
                        <td>
                          <strong>{displayTitle(product)}</strong><br />
                          <span className="muted small">{product.supplierSymbol || product.modelCode || "No symbol"}</span>
                        </td>
                        <td>
                          <strong>{product.supplierName}</strong><br />
                          <a href={product.supplierUrl} target="_blank" rel="noreferrer">Open supplier</a>
                        </td>
                        <td>{product.costPriceUah ? Math.round(product.costPriceUah) : 0} UAH</td>
                        <td>{product.salePriceUah || 0} UAH</td>
                        <td>{availableSizes || <span className="badge badge-yellow">Sold out</span>}</td>
                        <td>
                          {product.shopifyProductGid ? (
                            <>
                              <span className="badge badge-green">created</span><br />
                              {shopifyAdminUrl ? <a href={shopifyAdminUrl} target="_blank" rel="noreferrer">Open in Shopify</a> : null}
                            </>
                          ) : (
                            <span className="badge badge-yellow">not created</span>
                          )}
                        </td>
                        <td><span className={statusBadgeClass(product.status)}>{product.status}</span></td>
                        <td><span className={statusBadgeClass(product.stockSourceStatus)}>{product.stockSourceStatus}</span></td>
                        <td>
                          <span className={product.syncEnabled ? "badge badge-green" : "badge badge-yellow"}>
                            {product.syncEnabled ? "enabled" : "disabled"}
                          </span><br />
                          <span className="small muted">
                            {product.lastSyncedAt ? new Date(product.lastSyncedAt).toLocaleString() : "Never synced"}
                          </span>
                        </td>
                        <td>
                          <div className="button-row">
                            {!product.shopifyProductGid ? (
                              <>
                                <button className="btn btn-primary" type="submit" name="rowAction" value={`create_shopify_draft:${product.id}`} disabled={isBusy}>Create Draft</button>
                                <button
                                  className="btn"
                                  type="submit"
                                  name="rowAction"
                                  value={`create_shopify_active:${product.id}`}
                                  disabled={isBusy}
                                  onClick={(event) => {
                                    if (!confirm("Создать этот товар сразу Active?")) event.preventDefault();
                                  }}
                                >
                                  Create Active
                                </button>
                              </>
                            ) : (
                              <>
                                <button className="btn" type="submit" name="rowAction" value={`sync_now:${product.id}`} disabled={isBusy}>Sync Shopify stock</button>
                                <button className="btn" type="submit" name="rowAction" value={`sync_category_meta:${product.id}`} disabled={isBusy}>Sync category meta</button>
                              </>
                            )}

                            {product.syncEnabled ? (
                              <button className="btn" type="submit" name="rowAction" value={`disable_sync:${product.id}`} disabled={isBusy}>Disable sync</button>
                            ) : (
                              <button className="btn" type="submit" name="rowAction" value={`enable_sync:${product.id}`} disabled={isBusy}>Enable sync</button>
                            )}

                            <button
                              className="btn btn-danger"
                              type="submit"
                              name="rowAction"
                              value={`delete_product:${product.id}`}
                              disabled={isBusy}
                              onClick={(event) => {
                                if (!confirm("Удалить этот товар из приложения и Shopify, если он уже создан?")) event.preventDefault();
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </Form>
      )}
    </main>
  );
}
