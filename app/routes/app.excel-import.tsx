import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getVitkacProductId } from "../services/vitkac.server";
import { parseSpreadsheetFile, pickColumn } from "../services/spreadsheet.server";

function normalizeUrl(value: string) {
  return String(value || "").trim().split("?")[0].replace(/\/$/, "");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const queueItems = await db.importQueueItem.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  const stats = {
    total: await db.importQueueItem.count({ where: { shop: session.shop } }),
    queued: await db.importQueueItem.count({ where: { shop: session.shop, status: "queued" } }),
    duplicate: await db.importQueueItem.count({ where: { shop: session.shop, status: "duplicate" } }),
    imported: await db.importQueueItem.count({ where: { shop: session.shop, status: "imported" } }),
  };

  return { queueItems, stats };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "clear_queue") {
    await db.importQueueItem.deleteMany({ where: { shop: session.shop } });
    return { ok: true, message: "Очередь импорта очищена." };
  }

  if (intent === "delete_item") {
    const itemId = String(formData.get("itemId") || "");
    await db.importQueueItem.deleteMany({ where: { id: itemId, shop: session.shop } });
    return { ok: true, message: "Строка удалена из очереди." };
  }

  if (intent === "upload_links") {
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Загрузи Excel/CSV файл со ссылками." };
    }

    const rows = await parseSpreadsheetFile(file);
    let added = 0;
    let skipped = 0;
    let duplicates = 0;
    let invalid = 0;

    for (const row of rows) {
      const supplierUrl = normalizeUrl(
        pickColumn(row, [
          "supplier_url",
          "url",
          "link",
          "product_url",
          "vitkac_url",
          "посилання",
          "ссылка",
        ]),
      );

      if (!supplierUrl || !supplierUrl.includes("vitkac.com") || !supplierUrl.includes("/p/")) {
        invalid += 1;
        continue;
      }

      const supplierProductId = getVitkacProductId(supplierUrl) || "";
      const existingProduct = await db.importedProduct.findFirst({
        where: {
          shop: session.shop,
          OR: [{ supplierUrl }, ...(supplierProductId ? [{ supplierProductId }] : [])],
        },
      });

      if (existingProduct) {
        duplicates += 1;
        await db.importQueueItem.upsert({
          where: { shop_supplierUrl: { shop: session.shop, supplierUrl } },
          create: {
            shop: session.shop,
            supplierName: "Vitkac",
            supplierUrl,
            supplierProductId,
            status: "duplicate",
            note: `Уже импортирован: ${existingProduct.title}`,
            importedProductId: existingProduct.id,
          },
          update: {
            supplierProductId,
            status: "duplicate",
            note: `Уже импортирован: ${existingProduct.title}`,
            importedProductId: existingProduct.id,
          },
        });
        continue;
      }

      try {
        await db.importQueueItem.upsert({
          where: { shop_supplierUrl: { shop: session.shop, supplierUrl } },
          create: {
            shop: session.shop,
            supplierName: "Vitkac",
            supplierUrl,
            supplierProductId,
            status: "queued",
            note: "Готов к автоматическому Browser Capture из Chrome extension.",
          },
          update: {
            supplierProductId,
            status: "queued",
            note: "Готов к автоматическому Browser Capture из Chrome extension.",
          },
        });
        added += 1;
      } catch {
        skipped += 1;
      }
    }

    return {
      ok: true,
      message: `Excel обработан. Добавлено: ${added}. Дубли: ${duplicates}. Невалидные строки: ${invalid}. Пропущено: ${skipped}.`,
    };
  }

  return { ok: false, error: "Unknown action." };
};

export default function ExcelImport() {
  const { queueItems, stats } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isBusy = navigation.state !== "idle";

  const queuedUrls = queueItems
    .filter((item: any) => item.status === "queued")
    .map((item: any) => item.supplierUrl);

  function openQueuedTabs(limit: number) {
    const urls = queuedUrls.slice(0, limit);
    for (const url of urls) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <s-page heading="Excel Import">
      <s-section>
        <s-box padding="base" border="base" borderRadius="base">
          <s-stack direction="inline" gap="base">
            <s-box>
              <s-heading>Total</s-heading>
              <s-text>{stats.total}</s-text>
            </s-box>
            <s-box>
              <s-heading>Queued</s-heading>
              <s-text>{stats.queued}</s-text>
            </s-box>
            <s-box>
              <s-heading>Duplicates</s-heading>
              <s-text>{stats.duplicate}</s-text>
            </s-box>
            <s-box>
              <s-heading>Imported</s-heading>
              <s-text>{stats.imported}</s-text>
            </s-box>
          </s-stack>
        </s-box>
      </s-section>

      {actionData && "message" in actionData && actionData.message ? (
        <s-section>
          <s-banner tone="success">{actionData.message}</s-banner>
        </s-section>
      ) : null}

      {actionData && "error" in actionData && actionData.error ? (
        <s-section>
          <s-banner tone="critical">{actionData.error}</s-banner>
        </s-section>
      ) : null}

      <s-section>
        <s-box padding="base" border="base" borderRadius="base">
          <s-heading>1. Загрузка Excel/CSV со ссылками Vitkac</s-heading>
          <s-text>
            Поддерживаемые колонки: supplier_url, url, link, product_url, vitkac_url.
          </s-text>

          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="upload_links" />
            <input name="file" type="file" accept=".xlsx,.xls,.csv" />
            <s-button variant="primary" type="submit" disabled={isBusy}>
              {isBusy ? "Uploading..." : "Upload Excel"}
            </s-button>
          </Form>
        </s-box>
      </s-section>

      <s-section>
        <s-box padding="base" border="base" borderRadius="base">
          <s-heading>2. Автоматический импорт через Chrome extension</s-heading>
          <s-text>
            После загрузки Excel открой расширение ParserVo Vitkac Capture и нажми Start automatic import 20-by-20. Расширение само откроет 20 ссылок, импортирует их, закроет вкладки и перейдет к следующим ссылкам из очереди.
          </s-text>
          <s-text>
            Ручные кнопки ниже оставлены как запасной вариант для теста отдельных партий.
          </s-text>

          <s-stack direction="inline" gap="base">
            <button type="button" onClick={() => openQueuedTabs(5)} disabled={queuedUrls.length === 0}>
              Open first 5 queued links
            </button>
            <button type="button" onClick={() => openQueuedTabs(10)} disabled={queuedUrls.length === 0}>
              Open first 10 queued links
            </button>
            <button type="button" onClick={() => openQueuedTabs(20)} disabled={queuedUrls.length === 0}>
              Open first 20 queued links
            </button>
            <Form method="post">
              <input type="hidden" name="intent" value="clear_queue" />
              <s-button tone="critical" type="submit">Clear queue</s-button>
            </Form>
          </s-stack>

          <s-text>
            После Capture товары появятся в <Link to="/app/products">Imported Products</Link>.
          </s-text>
        </s-box>
      </s-section>

      <s-section>
        <s-box padding="base" border="base" borderRadius="base">
          <s-heading>Import queue</s-heading>
          {queueItems.length === 0 ? (
            <s-text>Очередь пустая. Загрузи Excel со ссылками.</s-text>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Status</s-table-header>
                <s-table-header>Product ID</s-table-header>
                <s-table-header>Supplier URL</s-table-header>
                <s-table-header>Note</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              {queueItems.map((item: any) => (
                <s-table-row key={item.id}>
                  <s-table-cell>{item.status}</s-table-cell>
                  <s-table-cell>{item.supplierProductId || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-link href={item.supplierUrl} target="_blank">Open</s-link>
                  </s-table-cell>
                  <s-table-cell>{item.note || "—"}</s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete_item" />
                      <input type="hidden" name="itemId" value={item.id} />
                      <s-button tone="critical" type="submit">Delete</s-button>
                    </Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table>
          )}
        </s-box>
      </s-section>
    </s-page>
  );
}
