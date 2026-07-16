import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const defaults = [
  { name: "Stone Island Poland Sale", code: "stone-island-pl", baseUrl: "https://www.stoneisland.com/en-pl", catalogUrl: "https://www.stoneisland.com/en-pl/men/sales/view-all-sales", currency: "PLN", exchangeRate: 12.19 },
  { name: "Vitkac", code: "vitkac", baseUrl: "https://www.vitkac.com", catalogUrl: "https://www.vitkac.com/", currency: "PLN", exchangeRate: 12.19 }
];

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const count = await db.supplierSource.count({ where: { shop: session.shop } });
  if (!count) await db.supplierSource.createMany({ data: defaults.map((x) => ({ ...x, shop: session.shop })) });
  return { sources: await db.supplierSource.findMany({ where: { shop: session.shop }, orderBy: { createdAt: "asc" } }) };
}

function num(value: FormDataEntryValue | null, fallback: number) { const n = Number(String(value ?? "").replace(",", ".")); return Number.isFinite(n) ? n : fallback; }
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const f = await request.formData();
  const id = String(f.get("id") || "");
  const data = {
    name: String(f.get("name") || "Source"), code: String(f.get("code") || "source"),
    baseUrl: String(f.get("baseUrl") || ""), catalogUrl: String(f.get("catalogUrl") || ""),
    currency: String(f.get("currency") || "PLN"), exchangeRate: num(f.get("exchangeRate"), 1),
    markupPercent: num(f.get("markupPercent"), 60), defaultQuantity: Math.max(0, Math.round(num(f.get("defaultQuantity"), 5))),
    captureMode: String(f.get("captureMode") || "browser"), enabled: f.get("enabled") === "on",
    updateExisting: f.get("updateExisting") === "on", hideUnavailable: f.get("hideUnavailable") === "on", autoImport: f.get("autoImport") === "on"
  };
  if (id) await db.supplierSource.updateMany({ where: { id, shop: session.shop }, data });
  else await db.supplierSource.create({ data: { ...data, shop: session.shop } });
  return { ok: true, message: "Источник сохранён." };
}

export default function Sources() {
  const { sources } = useLoaderData<typeof loader>(); const result = useActionData<typeof action>(); const nav = useNavigation();
  return <main className="app-page"><header className="app-header"><div><h1 className="app-title">Sources</h1><p className="app-subtitle">Ссылки, валюты и правила импорта меняются здесь — без правки кода.</p></div></header>
    {result?.message ? <div className="notice notice-success">{result.message}</div> : null}
    <div className="form-stack">{sources.map((s) => <Form method="post" className="card" key={s.id}>
      <input type="hidden" name="id" value={s.id}/><div className="form-grid">
      <div><label>Name</label><input name="name" defaultValue={s.name}/></div><div><label>Code</label><input name="code" defaultValue={s.code}/></div>
      <div style={{gridColumn:"1/-1"}}><label>Catalog URL</label><input name="catalogUrl" defaultValue={s.catalogUrl}/></div>
      <div style={{gridColumn:"1/-1"}}><label>Base URL</label><input name="baseUrl" defaultValue={s.baseUrl}/></div>
      <div><label>Currency</label><select name="currency" defaultValue={s.currency}>{["PLN","EUR","GBP","USD"].map(x=><option key={x}>{x}</option>)}</select></div>
      <div><label>Rate → UAH</label><input name="exchangeRate" defaultValue={String(s.exchangeRate)}/></div>
      <div><label>Markup %</label><input name="markupPercent" defaultValue={String(s.markupPercent)}/></div>
      <div><label>Default quantity</label><input name="defaultQuantity" type="number" defaultValue={s.defaultQuantity}/></div>
      <div><label>Capture mode</label><select name="captureMode" defaultValue={s.captureMode}><option value="browser">Browser capture</option><option value="server">Server request</option></select></div></div>
      <div className="form-grid" style={{marginTop:16}}>{[["enabled","Enabled",s.enabled],["updateExisting","Update existing",s.updateExisting],["hideUnavailable","Hide unavailable",s.hideUnavailable],["autoImport","Auto import",s.autoImport]].map(([n,l,c])=><label className="checkbox-row" key={String(n)}><input type="checkbox" name={String(n)} defaultChecked={Boolean(c)}/>{String(l)}</label>)}</div>
      <button className="button button-primary" disabled={nav.state!=="idle"}>SAVE SOURCE</button></Form>)}</div></main>;
}
