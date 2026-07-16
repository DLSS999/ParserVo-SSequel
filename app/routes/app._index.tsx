import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [totalProducts, activeProducts, soldOutProducts, syncErrorProducts, shopifyLinkedProducts, shopifyPendingProducts, lastSyncLog] =
    await Promise.all([
      db.importedProduct.count({ where: { shop: session.shop } }),
      db.importedProduct.count({ where: { shop: session.shop, status: "active" } }),
      db.importedProduct.count({
        where: { shop: session.shop, stockSourceStatus: "supplier_sold_out" },
      }),
      db.importedProduct.count({
        where: { shop: session.shop, stockSourceStatus: "sync_error" },
      }),
      db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: { not: null } } }),
      db.importedProduct.count({ where: { shop: session.shop, shopifyProductGid: null } }),
      db.syncLog.findFirst({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  return {
    shop: session.shop,
    totalProducts,
    activeProducts,
    soldOutProducts,
    syncErrorProducts,
    shopifyLinkedProducts,
    shopifyPendingProducts,
    lastSyncDate: lastSyncLog?.createdAt?.toISOString() || null,
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Supplier Import Sync</h1>
          <p className="app-subtitle">
            Админ-панель для импорта товаров поставщиков, контроля статусов и синхронизации наличия.
          </p>
        </div>
        <div className="button-row">
          <Link className="btn btn-primary" to="/app/sources">Sources</Link>
          <Link className="btn" to="/app/import">Import product</Link>
          <Link className="btn" to="/app/excel-import">Excel import</Link>
          <Link className="btn" to="/app/products">View products</Link>
        </div>
      </header>

      <section className="grid grid-4">
        <div className="card">
          <div className="metric-label">Total products</div>
          <div className="metric-value">{data.totalProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Created in Shopify</div>
          <div className="metric-value">{data.shopifyLinkedProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Sold out</div>
          <div className="metric-value">{data.soldOutProducts}</div>
        </div>
        <div className="card">
          <div className="metric-label">Pending transfer</div>
          <div className="metric-value">{data.shopifyPendingProducts}</div>
        </div>
      </section>

      <section className="grid grid-2 section-gap">
        <div className="card">
          <h2 className="card-title">Quick actions</h2>
          <div className="button-row">
            <Link className="btn btn-primary" to="/app/import">Вставить ссылку товара</Link>
            <Link className="btn" to="/app/excel-import">Excel import</Link>
            <Link className="btn" to="/app/products">Перенести в Shopify</Link>
            <Link className="btn" to="/app/stock-sync">Stock sync</Link>
            <Link className="btn" to="/app/settings">Настройки</Link>
            <Link className="btn" to="/app/logs">Sync logs</Link>
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">System status</h2>
          <p><strong>Shop:</strong> {data.shop}</p>
          <p><strong>Last sync:</strong> {data.lastSyncDate ? new Date(data.lastSyncDate).toLocaleString() : "No sync logs yet"}</p>
          <p className="muted small">Excel Import, перенос товаров в Shopify и Stock Sync подключены. Для обновления наличия можно использовать Excel/CSV или повторный browser capture Vitkac товаров.</p>
        </div>
      </section>
    </main>
  );
}
