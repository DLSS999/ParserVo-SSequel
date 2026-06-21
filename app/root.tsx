import type { LinksFunction, MetaFunction } from "@remix-run/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css";
import dashboardStyles from "./styles/dashboard.css";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: dashboardStyles },
];

export const meta: MetaFunction = () => [
  { title: "ParserVo" },
  { name: "viewport", content: "width=device-width,initial-scale=1" },
];

export default function Root() {
  return (
    <html lang="ru">
      <head><Meta /><Links /></head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
