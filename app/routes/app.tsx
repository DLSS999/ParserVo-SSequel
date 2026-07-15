import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { useEffect, useRef } from "react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

const STOCK_SYNC_ACTIVE_KEY = "parservo_background_stock_sync_active";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

function ParserVoBackgroundStockSyncRunner() {
  const isTickingRef = useRef(false);
  const consecutiveErrorsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function tickBackgroundStockSync() {
      if (cancelled || isTickingRef.current) return;
      if (window.localStorage.getItem(STOCK_SYNC_ACTIVE_KEY) !== "1") return;

      isTickingRef.current = true;

      try {
        const formData = new FormData();
        formData.set("intent", "tick");

        const response = await fetch(`/api/stock-sync-job${window.location.search}`, {
          method: "POST",
          body: formData,
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "ParserVoBackgroundStockSync",
          },
        });

        const rawText = await response.text();
        const contentType = response.headers.get("content-type") || "";

        if (!contentType.includes("application/json")) {
          throw new Error(`Stock sync API returned non JSON (${response.status}): ${rawText.replace(/\s+/g, " ").slice(0, 220)}`);
        }

        const data = JSON.parse(rawText);
        if (!response.ok || data?.error) throw new Error(data?.error || `Stock sync API error ${response.status}`);

        consecutiveErrorsRef.current = 0;
        window.dispatchEvent(new CustomEvent("parservo-stock-sync-job", { detail: data }));

        const status = data?.job?.status;
        if (status && status !== "running") {
          window.localStorage.removeItem(STOCK_SYNC_ACTIVE_KEY);
        }
      } catch (error) {
        consecutiveErrorsRef.current += 1;
        window.dispatchEvent(new CustomEvent("parservo-stock-sync-job", {
          detail: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));

        if (consecutiveErrorsRef.current >= 10) {
          window.localStorage.removeItem(STOCK_SYNC_ACTIVE_KEY);
        }
      } finally {
        isTickingRef.current = false;
      }
    }

    tickBackgroundStockSync();
    const timer = window.setInterval(tickBackgroundStockSync, 2500);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STOCK_SYNC_ACTIVE_KEY && event.newValue === "1") tickBackgroundStockSync();
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("parservo-stock-sync-started", tickBackgroundStockSync as EventListener);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("parservo-stock-sync-started", tickBackgroundStockSync as EventListener);
    };
  }, []);

  return null;
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/sources">Sources</Link>
        <Link to="/app/import">Import Product</Link>
        <Link to="/app/excel-import">Excel Import</Link>
        <Link to="/app/products">Imported Products</Link>
        <Link to="/app/stock-sync">Stock Sync</Link>
        <Link to="/app/warehouse-transfer">Warehouse Transfer</Link>
        <Link to="/app/seo">SEO Center</Link>
        <Link to="/app/logs">Sync Logs</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <ParserVoBackgroundStockSyncRunner />
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
