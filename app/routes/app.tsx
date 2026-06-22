import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "@remix-run/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-remix/server";
import { authenticate } from "../shopify.server";

const i18n = {
  Polaris: {
    Common: { checkbox: "checkbox" },
    ResourceList: {
      sortingLabel: "Sort by",
      defaultItemSingular: "item",
      defaultItemPlural: "items",
      showing: "Showing {itemsCount} {resource}",
      Item: { viewItem: "View details for {itemName}" },
      selected: "{selectedItemsCount} selected",
      allItemsSelected: "All {itemsLength}+ {resourceName} are selected",
      selectAllItems: "Select all {itemsLength}+ {resourceName}",
      emptySearchResultTitle: "No results found",
      emptySearchResultDescription: "Try changing the filters or search term",
      filteringLabel: "Filter",
      search: "Search",
    },
  },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const configReady = Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET && process.env.SHOPIFY_APP_URL);
  if (configReady) await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY || "", configReady });
};

export default function AppLayout() {
  const { apiKey, configReady } = useLoaderData<typeof loader>();
  const location = useLocation();
  return (
    <>
      {configReady ? <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key={apiKey} /> : null}
      <PolarisAppProvider i18n={i18n}>
        <nav className="pv-app-nav">
          <Link className={location.pathname === "/app" ? "active" : ""} to="/app">Каталог Shopify</Link>
          <Link className={location.pathname.startsWith("/app/crawler") ? "active" : ""} to="/app/crawler">Парсер и очередь</Link>
        </nav>
        <Outlet />
      </PolarisAppProvider>
    </>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
