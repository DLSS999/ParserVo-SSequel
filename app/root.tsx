import type { LinksFunction, MetaFunction } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import { AppProvider } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css";

const enTranslations = {
  Polaris: {
    Common: {
      checkbox: "checkbox",
    },
    ResourceList: {
      sortingLabel: "Sort by",
      defaultItemSingular: "item",
      defaultItemPlural: "items",
      showing: "Showing {itemsCount} {resource}",
      Item: {
        viewItem: "View details for {itemName}",
      },
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

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export const meta: MetaFunction = () => [
  { title: "ParserVo" },
  { name: "viewport", content: "width=device-width,initial-scale=1" },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <Meta />
        <Links />
      </head>
      <body>
        <AppProvider i18n={enTranslations}>
          <Outlet />
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  return (
    <html lang="en">
      <head>
        <title>ParserVo Error</title>
        <Meta />
        <Links />
      </head>
      <body>
        <AppProvider i18n={enTranslations}>
          <div style={{ padding: 24 }}>
            <h1>ParserVo error</h1>
            <p>Open the deployment logs to see the full error.</p>
          </div>
        </AppProvider>
        <Scripts />
      </body>
    </html>
  );
}
