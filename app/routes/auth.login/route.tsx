import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors, apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const errors = actionData?.errors || loaderData.errors;

  return (
    <AppProvider apiKey={loaderData.apiKey}>
      <div className="app-page" style={{ maxWidth: 520 }}>
        <div className="card">
          <h1 className="app-title">Log in</h1>
          <p className="app-subtitle">Enter your Shopify store domain to open the app.</p>
          <Form method="post" className="form-stack" style={{ marginTop: 18 }}>
            <div>
              <label htmlFor="shop">Shop domain</label>
              <input
                id="shop"
                name="shop"
                placeholder="your-store.myshopify.com"
                value={shop}
                onChange={(event) => setShop(event.currentTarget.value)}
                autoComplete="on"
              />
              {errors.shop ? <p className="small" style={{ color: "#d72c0d" }}>{errors.shop}</p> : null}
            </div>
            <button className="btn btn-primary" type="submit">Log in</button>
          </Form>
        </div>
      </div>
    </AppProvider>
  );
}
