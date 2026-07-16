import crypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopifyLocations } from "../services/shopify-products.server";

function parseDecimalFormValue(value: FormDataEntryValue | null, fallback: number) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntegerFormValue(value: FormDataEntryValue | null, fallback: number) {
  const parsed = Math.round(parseDecimalFormValue(value, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const existingSettings = await db.appSettings.findUnique({ where: { shop: session.shop } });

  const settings = existingSettings
    ? existingSettings.browserCaptureToken
      ? existingSettings
      : await db.appSettings.update({
          where: { shop: session.shop },
          data: { browserCaptureToken: crypto.randomBytes(24).toString("hex") },
        })
    : await db.appSettings.create({
        data: {
          shop: session.shop,
          browserCaptureToken: crypto.randomBytes(24).toString("hex"),
        },
      });

  let locations: Awaited<ReturnType<typeof getShopifyLocations>> = [];
  let locationsError = "";

  try {
    locations = await getShopifyLocations(admin);
  } catch (error) {
    locations = [];
    locationsError = error instanceof Error ? error.message : String(error);
  }

  return { settings, shop: session.shop, locations, locationsError };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const existingSettings = await db.appSettings.findUnique({ where: { shop: session.shop } });
  const existingToken = existingSettings?.browserCaptureToken || crypto.randomBytes(24).toString("hex");

  await db.appSettings.upsert({
    where: { shop: session.shop },
    create: {
      shop: session.shop,
      currencyRateEurUah: parseDecimalFormValue(formData.get("currencyRateEurUah"), 45),
      currencyRatePlnUah: parseDecimalFormValue(formData.get("currencyRatePlnUah"), 12.19),
      currencyRateGbpUah: parseDecimalFormValue(formData.get("currencyRateGbpUah"), 55),
      currencyRateUsdUah: parseDecimalFormValue(formData.get("currencyRateUsdUah"), 42),
      defaultMarkupPercent: parseDecimalFormValue(formData.get("defaultMarkupPercent"), 60),
      roundingRule: String(formData.get("roundingRule") || "round_to_5"),
      compareAtEnabled: formData.get("compareAtEnabled") === "on",
      compareAtFormula: String(formData.get("compareAtFormula") || "cinq_compare_at_v2"),
      syncIntervalHours: parseIntegerFormValue(formData.get("syncIntervalHours"), 6),
      defaultShopifyLocationId: String(formData.get("defaultShopifyLocationId") || ""),
      automaticSyncEnabled: formData.get("automaticSyncEnabled") === "on",
      autoDraftSoldOut: formData.get("autoDraftSoldOut") === "on",
      autoActivateAvailable: formData.get("autoActivateAvailable") === "on",
      translationEnabled: formData.get("translationEnabled") === "on",
      targetLanguage: "uk",
      browserCaptureToken: existingToken,
    },
    update: {
      currencyRateEurUah: parseDecimalFormValue(formData.get("currencyRateEurUah"), 45),
      currencyRatePlnUah: parseDecimalFormValue(formData.get("currencyRatePlnUah"), 12.19),
      currencyRateGbpUah: parseDecimalFormValue(formData.get("currencyRateGbpUah"), 55),
      currencyRateUsdUah: parseDecimalFormValue(formData.get("currencyRateUsdUah"), 42),
      defaultMarkupPercent: parseDecimalFormValue(formData.get("defaultMarkupPercent"), 60),
      roundingRule: String(formData.get("roundingRule") || "round_to_5"),
      compareAtEnabled: formData.get("compareAtEnabled") === "on",
      compareAtFormula: String(formData.get("compareAtFormula") || "cinq_compare_at_v2"),
      syncIntervalHours: parseIntegerFormValue(formData.get("syncIntervalHours"), 6),
      defaultShopifyLocationId: String(formData.get("defaultShopifyLocationId") || ""),
      automaticSyncEnabled: formData.get("automaticSyncEnabled") === "on",
      autoDraftSoldOut: formData.get("autoDraftSoldOut") === "on",
      autoActivateAvailable: formData.get("autoActivateAvailable") === "on",
      translationEnabled: formData.get("translationEnabled") === "on",
      targetLanguage: "uk",
    },
  });

  return { ok: true, message: "Settings saved." };
};

export default function Settings() {
  const { settings, shop, locations, locationsError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSaving = navigation.state !== "idle";

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Settings</h1>
          <p className="app-subtitle">Курс валют, наценка, округление, правила синхронизации и перевод.</p>
        </div>
      </header>

      {actionData?.message ? <div className="notice notice-success">{actionData.message}</div> : null}

      <Form method="post" className="form-stack">
        <section className="card">
          <h2 className="card-title">Pricing</h2>
          <div className="form-grid">
            <div>
              <label>EUR → UAH rate</label>
              <input name="currencyRateEurUah" type="text" inputMode="decimal" placeholder="45 або 45,00" defaultValue={String(settings.currencyRateEurUah)} />
            </div>
            <div>
              <label>PLN → UAH rate</label>
              <input name="currencyRatePlnUah" type="text" inputMode="decimal" placeholder="12.19 або 12,19" defaultValue={String(settings.currencyRatePlnUah)} />
            </div>
            <div><label>GBP → UAH rate</label><input name="currencyRateGbpUah" type="text" defaultValue={String(settings.currencyRateGbpUah)} /></div>
            <div><label>USD → UAH rate</label><input name="currencyRateUsdUah" type="text" defaultValue={String(settings.currencyRateUsdUah)} /></div>
            <div>
              <label>Markup %</label>
              <input name="defaultMarkupPercent" type="text" inputMode="decimal" placeholder="60" defaultValue={String(settings.defaultMarkupPercent)} />
            </div>
            <div>
              <label>Rounding rule</label>
              <select name="roundingRule" defaultValue={settings.roundingRule}>
                <option value="none">No rounding</option>
                <option value="round_to_5">Round to 5</option>
                <option value="round_to_10">Round to 10</option>
                <option value="round_to_50">Round to 50</option>
                <option value="round_to_100">Round to 100</option>
                <option value="round_to_500">Round to 500</option>
              </select>
            </div>
            <div>
              <label>Compare-at formula</label>
              <input name="compareAtFormula" defaultValue={settings.compareAtFormula} />
            </div>
          </div>
          <label className="checkbox-row" style={{ marginTop: 12 }}>
            <input name="compareAtEnabled" type="checkbox" defaultChecked={settings.compareAtEnabled} />
            Create compare-at price
          </label>
        </section>

        <section className="card">
          <h2 className="card-title">Sync</h2>
          <div className="form-grid">
            <div>
              <label>Sync interval, hours</label>
              <input name="syncIntervalHours" type="number" defaultValue={String(settings.syncIntervalHours)} />
            </div>
            <div>
              <label>Default Shopify Location</label>
              {locationsError ? (
                <p className="muted small" style={{ color: "#b42318", marginBottom: 8 }}>
                  Shopify не дал доступ к locations. Можно продолжать создавать товары без начальных остатков, но для Stock Sync нужно обновить scopes и переустановить приложение.
                </p>
              ) : null}
              {locations.length > 0 ? (
                <select name="defaultShopifyLocationId" defaultValue={settings.defaultShopifyLocationId || locations[0]?.id || ""}>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name} — {location.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input name="defaultShopifyLocationId" placeholder="gid://shopify/Location/... или просто числовой ID Location" defaultValue={settings.defaultShopifyLocationId || ""} />
              )}
            </div>
          </div>

          <div className="form-stack" style={{ marginTop: 12 }}>
            <label className="checkbox-row">
              <input name="automaticSyncEnabled" type="checkbox" defaultChecked={settings.automaticSyncEnabled} />
              Enable automatic sync
            </label>
            <label className="checkbox-row">
              <input name="autoDraftSoldOut" type="checkbox" defaultChecked={settings.autoDraftSoldOut} />
              Move sold out products to Draft
            </label>
            <label className="checkbox-row">
              <input name="autoActivateAvailable" type="checkbox" defaultChecked={settings.autoActivateAvailable} />
              Activate product when supplier has stock again
            </label>
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">Browser Capture Mode</h2>
          <p className="muted small">Это режим для Vitkac, когда сайт блокирует автоматический парсинг. Chrome extension берет HTML из твоего обычного браузера и отправляет его в приложение.</p>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div>
              <label>Shop</label>
              <input readOnly value={shop} />
            </div>
            <div>
              <label>Browser capture token</label>
              <input readOnly value={settings.browserCaptureToken || ""} />
            </div>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>В extension укажи Local API Base URL из PowerShell, например http://localhost:51220, shop и token из этого блока.</p>
        </section>

        <section className="card">
          <h2 className="card-title">Translation</h2>
          <label className="checkbox-row">
            <input name="translationEnabled" type="checkbox" defaultChecked={settings.translationEnabled} />
            Translate parsed data to Ukrainian
          </label>
        </section>

        <button className="btn btn-primary" type="submit" disabled={isSaving}>
          {isSaving ? "Saving..." : "Save settings"}
        </button>
      </Form>
    </main>
  );
}
