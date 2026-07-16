import crypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calculatePricing } from "../services/pricing.server";
import { detectSupplier, parseVitkacProduct, parseVitkacProductFromHtml } from "../services/vitkac.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

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

  return { settings, shop: session.shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const settings =
    (await db.appSettings.findUnique({ where: { shop: session.shop } })) ||
    (await db.appSettings.create({ data: { shop: session.shop } }));

  if (intent === "parse") {
    const supplierUrl = String(formData.get("supplierUrl") || "").trim();
    const pageHtml = String(formData.get("pageHtml") || "").trim();
    const eurRateForImportRaw = Number(formData.get("currencyRateEurUah") || settings.currencyRateEurUah);
    const plnRateForImportRaw = Number(formData.get("currencyRatePlnUah") || settings.currencyRatePlnUah);
    const eurRateForImport = Number.isFinite(eurRateForImportRaw) && eurRateForImportRaw > 0
      ? eurRateForImportRaw
      : settings.currencyRateEurUah;
    const plnRateForImport = Number.isFinite(plnRateForImportRaw) && plnRateForImportRaw > 0
      ? plnRateForImportRaw
      : settings.currencyRatePlnUah;

    if (!supplierUrl) {
      return { ok: false, error: "Вставьте ссылку товара." };
    }

    const supplier = detectSupplier(supplierUrl);

    if (!supplier) {
      return { ok: false, error: "Этот поставщик пока не поддерживается. Сейчас подключен только Vitkac." };
    }

    const duplicateByUrl = await db.importedProduct.findFirst({
      where: { shop: session.shop, supplierUrl },
    });

    if (duplicateByUrl) {
      return {
        ok: false,
        duplicate: true,
        error: "Товар уже импортирован.",
        existingProduct: duplicateByUrl,
      };
    }

    let parsedProduct;

    try {
      parsedProduct = pageHtml.length > 1000
        ? await parseVitkacProductFromHtml(supplierUrl, pageHtml)
        : await parseVitkacProduct(supplierUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        ok: false,
        error:
          "Vitkac заблокировал автоматический парсинг. Это защита Vitkac от ботов, а не ошибка Shopify. Используй HTML import mode: открой товар в обычном Chrome, нажми Ctrl+U, затем Ctrl+A, Ctrl+C, вернись сюда, вставь HTML в поле Vitkac page HTML и снова нажми Parse product. Деталь ошибки: " +
          message,
      };
    }

    const duplicateBySupplierId = await db.importedProduct.findFirst({
      where: { shop: session.shop, supplierProductId: parsedProduct.supplierProductId },
    });

    if (duplicateBySupplierId) {
      return {
        ok: false,
        duplicate: true,
        error: "Товар уже импортирован по supplier_product_id.",
        existingProduct: duplicateBySupplierId,
      };
    }

    const pricing = calculatePricing({
      supplierPrice: parsedProduct.supplierPrice,
      supplierOldPrice: parsedProduct.supplierOldPrice,
      currency: parsedProduct.supplierCurrency,
      eurRate: eurRateForImport,
      plnRate: plnRateForImport,
      markupPercent: settings.defaultMarkupPercent,
      roundingRule: settings.roundingRule,
      compareAtEnabled: settings.compareAtEnabled,
      compareAtFormula: settings.compareAtFormula,
    });

    return {
      ok: true,
      mode: "preview",
      product: {
        ...parsedProduct,
        ...pricing,
        eurRateForImport,
        plnRateForImport,
        markupPercent: settings.defaultMarkupPercent,
      },
    };
  }

  if (intent === "save") {
    const supplierUrl = String(formData.get("supplierUrl") || "");
    const supplierProductId = String(formData.get("supplierProductId") || "");
    const supplierName = String(formData.get("supplierName") || "Vitkac");

    const existingProduct = await db.importedProduct.findFirst({
      where: {
        shop: session.shop,
        OR: [{ supplierUrl }, { supplierProductId }],
      },
    });

    if (existingProduct) {
      return {
        ok: false,
        duplicate: true,
        error: "Товар уже импортирован.",
        existingProduct,
      };
    }

    const createdProduct = await db.importedProduct.create({
      data: {
        shop: session.shop,
        supplierName,
        supplierUrl,
        supplierProductId,
        supplierSymbol: String(formData.get("supplierSymbol") || ""),
        supplierCurrency: String(formData.get("supplierCurrency") || ""),
        exchangeRateUsed: Number(formData.get("exchangeRateUsed") || 0),
        supplierPrice: Number(formData.get("supplierPrice") || 0),
        supplierOldPrice: Number(formData.get("supplierOldPrice") || 0) || null,

        brand: String(formData.get("brand") || ""),
        title: String(formData.get("title") || ""),
        originalTitle: String(formData.get("originalTitle") || ""),
        description: String(formData.get("description") || ""),
        originalDescription: String(formData.get("originalDescription") || ""),

        color: String(formData.get("color") || ""),
        colorUa: String(formData.get("colorUa") || ""),
        gender: String(formData.get("gender") || ""),
        genderUa: String(formData.get("genderUa") || ""),
        category: String(formData.get("category") || ""),
        categoryUa: String(formData.get("categoryUa") || ""),
        productType: String(formData.get("productType") || ""),
        material: String(formData.get("material") || ""),
        composition: String(formData.get("composition") || ""),
        countryOfOrigin: String(formData.get("countryOfOrigin") || ""),
        modelCode: String(formData.get("modelCode") || ""),
        breadcrumbs: String(formData.get("breadcrumbs") || ""),

        costPriceUah: Number(formData.get("costPriceUah") || 0),
        salePriceUah: Number(formData.get("salePriceUah") || 0),
        compareAtPriceUah: Number(formData.get("compareAtPriceUah") || 0),
        markupPercent: Number(formData.get("markupPercent") || 0),

        imageUrl: String(formData.get("imageUrl") || ""),
        imagesJson: String(formData.get("imagesJson") || "[]"),

        status: "imported",
        stockSourceStatus: "supplier_available",
        syncEnabled: true,
      },
    });

    const variantsJson = String(formData.get("variantsJson") || "[]");
    const variants = JSON.parse(variantsJson) as Array<{
      size: string;
      supplierSizeLabel: string;
      available: boolean;
    }>;

    await db.importedVariant.createMany({
      data: variants.map((variant) => ({
        importedProductId: createdProduct.id,
        size: variant.size,
        supplierSizeLabel: variant.supplierSizeLabel,
        available: variant.available,
        lastAvailable: variant.available,
        sku: `${String(formData.get("supplierSymbol") || supplierProductId)}-${variant.size}`,
        price: Number(formData.get("salePriceUah") || 0),
        compareAtPrice: Number(formData.get("compareAtPriceUah") || 0),
      })),
    });

    await db.syncLog.create({
      data: {
        shop: session.shop,
        importedProductId: createdProduct.id,
        supplierName,
        supplierUrl,
        status: "imported",
        message: "Product imported into app database. Shopify product creation will be connected in the next step.",
      },
    });

    return {
      ok: true,
      mode: "saved",
      productId: createdProduct.id,
      message: "Товар сохранен в приложении. Следующим шагом подключим создание товара в Shopify.",
    };
  }

  return { ok: false, error: "Unknown action." };
};

type ActionData = {
  ok?: boolean;
  error?: string;
  duplicate?: boolean;
  message?: string;
  existingProduct?: any;
  product?: any;
};

export default function ImportProduct() {
  const { settings, shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const previewProduct = actionData?.product;

  return (
    <main className="app-page">
      <header className="app-header">
        <div>
          <h1 className="app-title">Import Product</h1>
          <p className="app-subtitle">Вставляем ссылку поставщика, проверяем дубли, смотрим preview и редактируем данные перед переносом.</p>
        </div>
        <Link className="btn" to="/app/products">Imported products</Link>
      </header>

      {actionData?.error ? (
        <div className={actionData.duplicate ? "notice notice-warning" : "notice notice-error"}>
          <strong>{actionData.error}</strong>
          {actionData.existingProduct ? (
            <div className="small" style={{ marginTop: 8 }}>
              Shopify title: {actionData.existingProduct.shopifyProductTitle || actionData.existingProduct.title}<br />
              Status: {actionData.existingProduct.status}<br />
              Last sync: {actionData.existingProduct.lastSyncedAt ? new Date(actionData.existingProduct.lastSyncedAt).toLocaleString() : "Never"}
            </div>
          ) : null}
        </div>
      ) : null}

      {actionData?.message ? <div className="notice notice-success">{actionData.message}</div> : null}

      <section className="card">
        <h2 className="card-title">Browser Capture Mode для массового импорта Vitkac</h2>
        <p className="muted small">Если Vitkac блокирует автоматический parser, используй Chrome extension из папки <strong>chrome-extension</strong>. Он берет HTML из открытой вкладки Vitkac в твоем обычном Chrome и отправляет товар прямо в Imported Products.</p>
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
        <p className="muted small" style={{ marginTop: 8 }}>В extension также укажи Local API Base URL из PowerShell, например <strong>http://localhost:51220</strong>. Его видно в строке Local после запуска shopify app dev.</p>
      </section>

      <section className="card">
        <h2 className="card-title">Ссылка товара</h2>
        <Form method="post" className="form-stack">
          <input type="hidden" name="intent" value="parse" />
          <div>
            <label htmlFor="supplierUrl">Supplier product URL</label>
            <input
              id="supplierUrl"
              name="supplierUrl"
              placeholder="https://www.vitkac.com/pl/p/heeled-shoes-spino-marsell-shoes-1836330"
            />
          </div>

          <div className="form-grid">
            <div>
              <label htmlFor="currencyRatePlnUah">PLN → UAH курс для этого импорта</label>
              <input
                id="currencyRatePlnUah"
                name="currencyRatePlnUah"
                type="number"
                step="0.01"
                defaultValue={String(settings.currencyRatePlnUah)}
              />
            </div>
            <div>
              <label htmlFor="currencyRateEurUah">EUR → UAH курс для этого импорта</label>
              <input
                id="currencyRateEurUah"
                name="currencyRateEurUah"
                type="number"
                step="0.01"
                defaultValue={String(settings.currencyRateEurUah)}
              />
            </div>
          </div>

          <p className="muted small">Этот курс применяется только к текущему товару и сохраняется в карточке импорта. Глобальные настройки в Settings не меняются.</p>

          <details className="card soft-card">
            <summary><strong>HTML import mode, если Vitkac блокирует автоматический парсинг</strong></summary>
            <p className="muted small" style={{ marginTop: 8 }}>
              Если видишь ошибку 403 / bot / access denied: открой товар Vitkac в обычном Chrome, нажми Ctrl+U, потом Ctrl+A, Ctrl+C, вернись сюда и вставь полный HTML ниже. После этого нажми Parse product. Ссылка товара сверху всё равно обязательна.
            </p>
            <div style={{ marginTop: 12 }}>
              <label htmlFor="pageHtml">Vitkac page HTML, optional</label>
              <textarea
                id="pageHtml"
                name="pageHtml"
                rows={8}
                placeholder="Вставь сюда полный HTML страницы Vitkac, если автоматический парсер заблокирован"
              />
            </div>
          </details>

          <button className="btn btn-primary" type="submit" disabled={isLoading}>
            {isLoading ? "Parsing..." : "Parse product"}
          </button>
        </Form>
      </section>

      {previewProduct ? (
        <section className="card section-gap">
          <h2 className="card-title">Preview before Shopify import</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="supplierName" value={previewProduct.supplierName} />
            <input type="hidden" name="supplierUrl" value={previewProduct.supplierUrl} />
            <input type="hidden" name="supplierProductId" value={previewProduct.supplierProductId} />
            <input type="hidden" name="supplierCurrency" value={previewProduct.supplierCurrency} />
            <input type="hidden" name="supplierPrice" value={previewProduct.supplierPrice} />
            <input type="hidden" name="supplierOldPrice" value={previewProduct.supplierOldPrice || 0} />
            <input type="hidden" name="markupPercent" value={previewProduct.markupPercent} />
            <input type="hidden" name="imagesJson" value={JSON.stringify(previewProduct.images)} />
            <input type="hidden" name="variantsJson" value={JSON.stringify(previewProduct.variants)} />
            <input type="hidden" name="imageUrl" value={previewProduct.images[0] || ""} />

            <div className="grid grid-2">
              <div>
                {previewProduct.images[0] ? (
                  <img className="preview-image" src={previewProduct.images[0]} alt={previewProduct.title} />
                ) : (
                  <div className="card">No image</div>
                )}

                <div className="card section-gap">
                  <h3 className="card-title">All photos</h3>
                  <p className="muted small">Все фото берем из product_thumb Vitkac. Первое фото станет главным фото товара.</p>
                  <ol className="small">
                    {previewProduct.images.map((image: string) => (
                      <li key={image}>{image}</li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="form-stack">
                <div className="form-grid">
                  <div><label>Brand</label><input name="brand" defaultValue={previewProduct.brand} /></div>
                  <div><label>Symbol / SKU</label><input name="supplierSymbol" defaultValue={previewProduct.supplierSymbol || ""} /></div>
                  <div><label>Model code</label><input name="modelCode" defaultValue={previewProduct.modelCode || ""} /></div>
                  <div><label>COLOR English</label><input name="color" defaultValue={previewProduct.color} /></div>
                  <div><label>Color UA</label><input name="colorUa" defaultValue={previewProduct.colorUa} /></div>
                  <div><label>Gender English</label><input name="gender" defaultValue={previewProduct.gender} /></div>
                  <div><label>Gender UA</label><input name="genderUa" defaultValue={previewProduct.genderUa} /></div>
                  <div><label>Product type UA</label><input name="productType" defaultValue={previewProduct.productType} /></div>
                  <div><label>Original category</label><input name="category" defaultValue={previewProduct.category} /></div>
                  <div><label>Category UA</label><input name="categoryUa" defaultValue={previewProduct.categoryUa} /></div>
                  <div><label>Material</label><input name="material" defaultValue={previewProduct.material} /></div>
                  <div><label>Composition</label><input name="composition" defaultValue={previewProduct.composition} /></div>
                </div>

                <div><label>Product title UA</label><input name="title" defaultValue={previewProduct.title} /></div>
                <div><label>Original title</label><input name="originalTitle" defaultValue={previewProduct.originalTitle} /></div>
                <div><label>Breadcrumbs</label><input name="breadcrumbs" defaultValue={previewProduct.breadcrumbs} /></div>
                <div><label>Description UA</label><textarea name="description" defaultValue={previewProduct.description} /></div>
                <div><label>Original description</label><textarea name="originalDescription" defaultValue={previewProduct.originalDescription} /></div>

                <div className="card">
                  <h3 className="card-title">Pricing</h3>
                  <p>Supplier price: <strong>{previewProduct.supplierPrice} {previewProduct.supplierCurrency}</strong></p>
                  {previewProduct.supplierOldPrice ? (
                    <p>Supplier old price: <strong>{previewProduct.supplierOldPrice} {previewProduct.supplierCurrency}</strong></p>
                  ) : null}
                  <p>Formula: <strong>CINQ custom formula v2</strong></p>

                  <div className="form-grid" style={{ marginTop: 12 }}>
                    <div>
                      <label>Exchange rate used</label>
                      <input
                        name="exchangeRateUsed"
                        type="number"
                        step="0.01"
                        defaultValue={String(previewProduct.exchangeRateUsed || 1)}
                      />
                    </div>
                    <div>
                      <label>Cost price UAH</label>
                      <input
                        name="costPriceUah"
                        type="number"
                        step="1"
                        defaultValue={String(previewProduct.costPriceUah)}
                      />
                    </div>
                    <div>
                      <label>Sale price UAH</label>
                      <input
                        name="salePriceUah"
                        type="number"
                        step="1"
                        defaultValue={String(previewProduct.salePriceUah)}
                      />
                    </div>
                    <div>
                      <label>Compare-at UAH</label>
                      <input
                        name="compareAtPriceUah"
                        type="number"
                        step="1"
                        defaultValue={String(previewProduct.compareAtPriceUah || 0)}
                      />
                    </div>
                  </div>

                  <p className="muted small" style={{ marginTop: 8 }}>
                    Если нужно — можешь вручную поправить цену перед сохранением. Для автоматического пересчета поменяй курс сверху и снова нажми Parse product.
                  </p>
                </div>

                <div className="card">
                  <h3 className="card-title">Sizes</h3>
                  <div className="button-row">
                    {previewProduct.variants.map((variant: any) => (
                      <span key={variant.size} className={variant.available ? "badge badge-green" : "badge badge-yellow"}>
                        {variant.size} — {variant.available ? "available" : "sold out"}
                      </span>
                    ))}
                  </div>
                </div>

                <button className="btn btn-primary" type="submit" disabled={isLoading}>
                  Save imported product
                </button>
              </div>
            </div>
          </Form>
        </section>
      ) : null}
    </main>
  );
}
