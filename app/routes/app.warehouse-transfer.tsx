import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { useMemo, useRef, useState } from "react";

import { authenticate } from "../shopify.server";
import { getShopifyLocations, getShopifyProductTags } from "../services/shopify-products.server";

type TransferProgress = {
  running: boolean;
  done: boolean;
  dryRun: boolean;
  processedProducts: number;
  movedProducts: number;
  updatedVariants: number;
  skippedVariants: number;
  failedVariants: number;
  movedUnits: number;
  batches: number;
  cursor: string | null;
  lastMessage: string;
  errors: string[];
  productLines: string[];
};

function defaultProgress(): TransferProgress {
  return {
    running: false,
    done: false,
    dryRun: false,
    processedProducts: 0,
    movedProducts: 0,
    updatedVariants: 0,
    skippedVariants: 0,
    failedVariants: 0,
    movedUnits: 0,
    batches: 0,
    cursor: null,
    lastMessage: "Очередь переноса не запущена.",
    errors: [],
    productLines: [],
  };
}

function normalize(value: string) {
  return String(value || "").trim();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [locations, tags] = await Promise.all([
    getShopifyLocations(admin),
    getShopifyProductTags(admin),
  ]);

  return {
    locations,
    tags,
  };
};

export default function WarehouseTransferPage() {
  const { locations, tags } = useLoaderData<typeof loader>();
  const [sourceLocationId, setSourceLocationId] = useState(locations[0]?.id || "");
  const [destinationLocationId, setDestinationLocationId] = useState(locations.find((location: any) => location.id !== locations[0]?.id)?.id || "");
  const [selectedTag, setSelectedTag] = useState(tags.includes("Vitkac") ? "Vitkac" : (tags[0] || ""));
  const [manualTag, setManualTag] = useState("");
  const [batchSize, setBatchSize] = useState("10");
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [progress, setProgress] = useState<TransferProgress>(() => defaultProgress());
  const stopRef = useRef(false);

  const tagToUse = useMemo(() => normalize(manualTag) || normalize(selectedTag), [manualTag, selectedTag]);
  const canStart = Boolean(tagToUse && sourceLocationId && destinationLocationId && sourceLocationId !== destinationLocationId && !progress.running);

  async function runTransfer(dryRun: boolean) {
    if (!canStart) return;

    stopRef.current = false;
    let cursor: string | null = null;
    let batchNumber = 0;

    setProgress({
      ...defaultProgress(),
      running: true,
      dryRun,
      lastMessage: dryRun ? "Тестовый просмотр первой партии запущен..." : "Полный перенос остатков запущен...",
    });

    while (!stopRef.current) {
      batchNumber += 1;
      const formData = new FormData();
      formData.set("tag", tagToUse);
      formData.set("sourceLocationId", sourceLocationId);
      formData.set("destinationLocationId", destinationLocationId);
      formData.set("batchSize", batchSize);
      formData.set("mode", mode);
      if (cursor) formData.set("cursor", cursor);
      if (dryRun) formData.set("dryRun", "1");

      try {
        const response = await fetch(`/api/warehouse-transfer-batch${window.location.search}`, {
          method: "POST",
          body: formData,
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "X-Requested-With": "ParserVoWarehouseTransfer",
          },
        });

        const text = await response.text();
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          throw new Error(`API вернул не JSON (${response.status}): ${text.replace(/\s+/g, " ").slice(0, 220)}`);
        }

        const data = JSON.parse(text);
        if (!response.ok || data?.error) throw new Error(data?.error || `API error ${response.status}`);

        cursor = data.nextCursor || null;
        const lines = (data.products || [])
          .filter((item: any) => Number(item.movedUnits || 0) > 0 || Number(item.updatedVariants || 0) > 0 || Number(item.errors?.length || 0) > 0)
          .map((item: any) => `${item.title}: ${item.movedUnits || 0} шт, variants ${item.updatedVariants || 0}${item.errors?.length ? `, errors ${item.errors.length}` : ""}`);

        setProgress((prev) => ({
          ...prev,
          running: dryRun ? false : Boolean(data.hasNextPage && cursor && !stopRef.current),
          done: dryRun ? true : !data.hasNextPage,
          batches: prev.batches + 1,
          cursor,
          processedProducts: prev.processedProducts + Number(data.processedProducts || 0),
          movedProducts: prev.movedProducts + Number(data.movedProducts || 0),
          updatedVariants: prev.updatedVariants + Number(data.updatedVariants || 0),
          skippedVariants: prev.skippedVariants + Number(data.skippedVariants || 0),
          failedVariants: prev.failedVariants + Number(data.failedVariants || 0),
          movedUnits: prev.movedUnits + Number(data.movedUnits || 0),
          errors: [...prev.errors, ...(data.errors || [])].slice(-80),
          productLines: [...prev.productLines, ...lines].slice(-120),
          lastMessage: dryRun
            ? "Тестовый просмотр первой партии завершен. Остатки в Shopify не менялись."
            : data.hasNextPage
              ? `Партия ${batchNumber} завершена. Следующая партия запускается автоматически...`
              : "Полный перенос завершен.",
        }));

        if (dryRun || !data.hasNextPage || !cursor) break;
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "Unknown transfer error");
        setProgress((prev) => ({
          ...prev,
          running: false,
          done: false,
          errors: [...prev.errors, message].slice(-80),
          lastMessage: `Перенос остановлен с ошибкой: ${message}`,
        }));
        break;
      }
    }

    if (stopRef.current) {
      setProgress((prev) => ({
        ...prev,
        running: false,
        done: false,
        lastMessage: "Перенос остановлен вручную. Уже перенесенные остатки не откатываются.",
      }));
    }
  }

  function stopTransfer() {
    stopRef.current = true;
    setProgress((prev) => ({ ...prev, running: false, lastMessage: "Останавливаю после текущей партии..." }));
  }

  return (
    <div className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Warehouse Transfer</h1>
          <p className="app-subtitle">
            Перенос остатков между складами Shopify по выбранному тегу. Выбираешь склад-отправитель, склад-получатель и тег — ParserVo переносит все доступное наличие автоматически.
          </p>
        </div>
        <div className="button-row">
          <Link className="btn" to="/app/products">Imported Products</Link>
          <Link className="btn" to="/app/stock-sync">Stock Sync</Link>
        </div>
      </header>

      <section className="grid grid-4 section-gap">
        <div className="card">
          <div className="metric-label">Shopify locations</div>
          <div className="metric-value">{locations.length}</div>
        </div>
        <div className="card">
          <div className="metric-label">Product tags loaded</div>
          <div className="metric-value">{tags.length}</div>
        </div>
        <div className="card">
          <div className="metric-label">Moved units</div>
          <div className="metric-value">{progress.movedUnits}</div>
        </div>
        <div className="card">
          <div className="metric-label">Updated variants</div>
          <div className="metric-value">{progress.updatedVariants}</div>
        </div>
      </section>

      <section className="card section-gap">
        <h2 className="card-title">1. Настрой перенос</h2>
        <div className="form-grid warehouse-transfer-grid">
          <div>
            <label>Склад, с которого переносим</label>
            <select value={sourceLocationId} onChange={(event) => setSourceLocationId(event.currentTarget.value)} disabled={progress.running}>
              <option value="">Выбери склад</option>
              {locations.map((location: any) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Склад, на который переносим</label>
            <select value={destinationLocationId} onChange={(event) => setDestinationLocationId(event.currentTarget.value)} disabled={progress.running}>
              <option value="">Выбери склад</option>
              {locations.map((location: any) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Тег Shopify</label>
            <select value={selectedTag} onChange={(event) => setSelectedTag(event.currentTarget.value)} disabled={progress.running || Boolean(manualTag)}>
              <option value="">Выбери тег</option>
              {tags.map((tag: string) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </div>
          <div>
            <label>Или введи тег вручную</label>
            <input value={manualTag} onChange={(event) => setManualTag(event.currentTarget.value)} placeholder="Например: Vitkac, PreOrder, SALE" disabled={progress.running} />
          </div>
          <div>
            <label>Размер партии</label>
            <select value={batchSize} onChange={(event) => setBatchSize(event.currentTarget.value)} disabled={progress.running}>
              <option value="5">5 товаров</option>
              <option value="10">10 товаров</option>
              <option value="15">15 товаров</option>
              <option value="20">20 товаров</option>
              <option value="25">25 товаров</option>
            </select>
          </div>
          <div>
            <label>Как переносить на склад-получатель</label>
            <select value={mode} onChange={(event) => setMode(event.currentTarget.value as "add" | "replace")} disabled={progress.running}>
              <option value="add">Добавить к текущему остатку склада-получателя</option>
              <option value="replace">Заменить остаток склада-получателя</option>
            </select>
          </div>
        </div>

        {sourceLocationId && destinationLocationId && sourceLocationId === destinationLocationId ? (
          <div className="notice notice-error section-gap">Склад-отправитель и склад-получатель не могут быть одинаковыми.</div>
        ) : null}

        <div className="notice notice-warning section-gap">
          <strong>Логика полного переноса:</strong> если на складе-отправителе у variant есть 3 шт, ParserVo ставит на складе-отправителе 0 шт и добавляет эти 3 шт на склад-получатель. Товары выбираются только по указанному Shopify тегу.
        </div>

        <div className="button-row section-gap">
          <button className="btn" type="button" disabled={!canStart} onClick={() => runTransfer(true)}>
            Preview first batch без изменения Shopify
          </button>
          <button className="btn btn-primary" type="button" disabled={!canStart} onClick={() => runTransfer(false)}>
            Start full transfer by tag
          </button>
          <button className="btn btn-danger" type="button" disabled={!progress.running} onClick={stopTransfer}>
            Stop after current batch
          </button>
        </div>
      </section>

      <section className={`notice section-gap ${progress.errors.length ? "notice-warning" : progress.done ? "notice-success" : "notice-warning"}`}>
        <strong>{progress.lastMessage}</strong>
        <div className="warehouse-progress-bar" aria-hidden="true"><span style={{ width: progress.running ? "60%" : progress.done ? "100%" : "12%" }} /></div>
        <div className="warehouse-progress-grid">
          <span>Batch: {progress.batches}</span>
          <span>Processed products: {progress.processedProducts}</span>
          <span>Moved products: {progress.movedProducts}</span>
          <span>Moved units: {progress.movedUnits}</span>
          <span>Updated variants: {progress.updatedVariants}</span>
          <span>Skipped variants: {progress.skippedVariants}</span>
          <span>Failed variants: {progress.failedVariants}</span>
          <span>Mode: {mode}</span>
        </div>
      </section>

      <section className="grid grid-2 section-gap">
        <div className="card">
          <h2 className="card-title">Последние перенесенные товары</h2>
          {progress.productLines.length ? (
            <pre className="warehouse-log-box">{progress.productLines.join("\n")}</pre>
          ) : (
            <p className="app-subtitle">После запуска тут появятся товары и количество перенесенных единиц.</p>
          )}
        </div>
        <div className="card">
          <h2 className="card-title">Ошибки</h2>
          {progress.errors.length ? (
            <pre className="warehouse-log-box warehouse-log-error">{progress.errors.join("\n")}</pre>
          ) : (
            <p className="app-subtitle">Ошибок пока нет.</p>
          )}
        </div>
      </section>
    </div>
  );
}
