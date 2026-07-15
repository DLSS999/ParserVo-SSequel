import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { statusBadgeClass } from "../services/status";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const logs = await db.syncLog.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return { logs };
};

export default function SyncLogs() {
  const { logs } = useLoaderData<typeof loader>();

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Sync Logs</h1>
          <p className="app-subtitle">История импорта, ручной синхронизации и будущих автоматических проверок наличия.</p>
        </div>
      </header>

      <section className="card">
        {logs.length === 0 ? (
          <p className="muted">No sync logs yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th>Message</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: any) => (
                  <tr key={log.id}>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                    <td>{log.supplierName || "—"}</td>
                    <td><span className={statusBadgeClass(log.status)}>{log.status}</span></td>
                    <td>{log.message || "—"}</td>
                    <td>{log.errorMessage || "—"}</td>
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
