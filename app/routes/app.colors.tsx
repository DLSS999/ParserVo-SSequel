import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import {
  deleteColorMapping,
  loadColorMappings,
  loadDiscoveredColors,
  STANDARD_COLORS,
  upsertColorMapping,
} from "../services/color-mappings.server";

const colorPageStyles = `
  .pvc-color-grid {
    display: grid;
    grid-template-columns: minmax(220px, 1.4fr) minmax(180px, 1fr) auto;
    gap: 14px;
    align-items: end;
  }
  .pvc-color-grid label,
  .pvc-color-row label {
    display: grid;
    gap: 8px;
    font-size: 10px;
    color: #222;
    text-transform: uppercase;
    letter-spacing: .05em;
  }
  .pvc-color-input,
  .pvc-color-select {
    width: 100%;
    min-height: 42px;
    border: 1px solid #9e9e9e;
    border-radius: 0;
    padding: 0 12px;
    background: #fff;
    color: #000;
    font: inherit;
    font-size: 12px;
  }
  .pvc-color-row {
    display: grid;
    grid-template-columns: minmax(220px, 1.5fr) minmax(180px, 1fr) auto auto;
    gap: 12px;
    align-items: center;
  }
  .pvc-color-row + .pvc-color-row {
    border-top: 1px solid #ddd;
    padding-top: 12px;
    margin-top: 12px;
  }
  .pvc-color-source {
    font-size: 12px;
    font-weight: 700;
  }
  .pvc-color-preview {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .pvc-color-swatch {
    width: 22px;
    height: 22px;
    border: 1px solid #888;
    background: var(--swatch, #fff);
  }
  .pvc-color-muted {
    color: #777;
    font-size: 10px;
    text-transform: uppercase;
  }
  @media (max-width: 760px) {
    .pvc-color-grid,
    .pvc-color-row {
      grid-template-columns: 1fr;
    }
  }
`;

const swatches: Record<string, string> = {
  Silver: "#c0c0c0",
  Red: "#d52222",
  Purple: "#8038a8",
  Pink: "#ef9eb4",
  Green: "#2b8f4b",
  Gray: "#808080",
  Blue: "#2566c2",
  Black: "#111111",
  Beige: "#e9dfbd",
  Brown: "#8b4d22",
  Navy: "#1b2d5a",
  White: "#ffffff",
  Bronze: "#b06c2f",
  Clear: "linear-gradient(135deg,#fff 0 45%,#ddd 45% 55%,#fff 55%)",
  Gold: "#d9a814",
  Orange: "#ef7d19",
  "Rose gold": "#b97879",
  Yellow: "#f0d400",
};

function colorOptions() {
  return STANDARD_COLORS.map((color) => <option key={color} value={color}>{color}</option>);
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const [mappings, discovered] = await Promise.all([
    loadColorMappings(true),
    loadDiscoveredColors(),
  ]);
  return json({ mappings, discovered, standardColors: STANDARD_COLORS });
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");
  const sourceColor = String(form.get("sourceColor") || "").trim();

  try {
    if (intent === "delete") {
      await deleteColorMapping(sourceColor);
      return json({ ok: true, message: `Правило ${sourceColor} удалено.` });
    }

    const standardColor = String(form.get("standardColor") || "").trim();
    const enabled = String(form.get("enabled") || "true") !== "false";
    await upsertColorMapping(sourceColor, standardColor, enabled);
    return json({ ok: true, message: `${sourceColor} → ${standardColor} сохранено.` });
  } catch (error) {
    return json({
      ok: false,
      message: error instanceof Error ? error.message : "Не удалось сохранить правило цвета.",
    });
  }
}

export default function ColorsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const exactSources = new Set(data.mappings.map((mapping) => mapping.source_color.toLowerCase()));
  const discoveredWithoutRule = data.discovered.filter((item) => !exactSources.has(item.sourceColor.toLowerCase()));

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: colorPageStyles }} />
      <main className="pv-stack">
        <div className="pv-page-header">
          <div>
            <h1>STONE ISLAND / COLORS</h1>
            <p>Укажите, к какому стандартному Shopify-цвету относится название поставщика.</p>
          </div>
          <div className="pv-header">
            <span className="pv-pill pv-pill-green">Правил: {data.mappings.length}</span>
            <span className="pv-pill">Новых цветов: {discoveredWithoutRule.length}</span>
          </div>
        </div>

        {actionData?.message ? (
          <div className={`pv-alert ${actionData.ok ? "pv-alert-success" : "pv-alert-error"}`}>
            {actionData.message}
          </div>
        ) : null}

        <section className="pv-card">
          <h2 className="pv-title">ДОБАВИТЬ НОВОЕ СООТВЕТСТВИЕ</h2>
          <p className="pv-note">Точное правило имеет приоритет над автоматическим распознаванием. Исходный нестандартный цвет также сохраняется в Tags.</p>
          <Form method="post" className="pvc-color-grid">
            <input type="hidden" name="intent" value="save" />
            <label>
              <span>Цвет поставщика</span>
              <input className="pvc-color-input" name="sourceColor" placeholder="Например: Oleander" required />
            </label>
            <label>
              <span>Стандартный цвет Shopify</span>
              <select className="pvc-color-select" name="standardColor" defaultValue="Blue">{colorOptions()}</select>
            </label>
            <button className="pv-button pv-button-primary" type="submit">СОХРАНИТЬ ПРАВИЛО</button>
          </Form>
        </section>

        <section className="pv-card">
          <div className="pv-header">
            <div>
              <h2 className="pv-title">ЦВЕТА, НАЙДЕННЫЕ В КАТАЛОГЕ</h2>
              <p className="pv-note">Здесь видны новые названия Stone Island. Сохраните точное правило, когда автоматическое значение неверно или отсутствует.</p>
            </div>
            <button className="pv-button" type="button" onClick={() => revalidator.revalidate()}>ОБНОВИТЬ СПИСОК</button>
          </div>

          {discoveredWithoutRule.length ? discoveredWithoutRule.map((item) => (
            <Form method="post" className="pvc-color-row" key={item.sourceColor}>
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="sourceColor" value={item.sourceColor} />
              <div>
                <div className="pvc-color-source">{item.sourceColor}</div>
                <div className="pvc-color-muted">Нет точного правила</div>
              </div>
              <label>
                <span>Стандартный цвет</span>
                <select className="pvc-color-select" name="standardColor" defaultValue={item.standardColor || "Blue"}>{colorOptions()}</select>
              </label>
              <div className="pvc-color-preview">
                <span className="pvc-color-swatch" style={{ "--swatch": swatches[item.standardColor] || "#fff" } as React.CSSProperties} />
                {item.standardColor || "Не распознан"}
              </div>
              <button className="pv-button" type="submit">ДОБАВИТЬ</button>
            </Form>
          )) : <p className="pv-note">Все найденные цвета уже имеют точные правила.</p>}
        </section>

        <section className="pv-card">
          <h2 className="pv-title">СОХРАНЁННЫЕ ПРАВИЛА</h2>
          <p className="pv-note">Изменение применяется ко всем следующим загрузкам и повторным синхронизациям товаров.</p>

          {data.mappings.map((mapping) => (
            <div className="pvc-color-row" key={mapping.source_color}>
              <div>
                <div className="pvc-color-source">{mapping.source_color}</div>
                <div className="pvc-color-muted">{mapping.enabled ? "Активно" : "Отключено"}</div>
              </div>
              <Form method="post" className="pvc-color-row" style={{ display: "contents" }}>
                <input type="hidden" name="intent" value="save" />
                <input type="hidden" name="sourceColor" value={mapping.source_color} />
                <input type="hidden" name="enabled" value="true" />
                <label>
                  <span>Стандартный цвет</span>
                  <select className="pvc-color-select" name="standardColor" defaultValue={mapping.standard_color}>{colorOptions()}</select>
                </label>
                <div className="pvc-color-preview">
                  <span className="pvc-color-swatch" style={{ "--swatch": swatches[mapping.standard_color] || "#fff" } as React.CSSProperties} />
                  {mapping.standard_color}
                </div>
                <button className="pv-button" type="submit">СОХРАНИТЬ</button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="sourceColor" value={mapping.source_color} />
                <button className="pv-button" type="submit">УДАЛИТЬ</button>
              </Form>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
