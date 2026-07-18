// ParserVo Stone Island Capture 2.9.6: inventory-only refresh for already imported products.

let parserVoCaptureMode = "";
const jsonRequestBeforeStockRefresh = jsonRequest;

jsonRequest = async function jsonRequestWithStockMode(url, options, timeoutMs) {
  if (
    parserVoCaptureMode === "STOCK_ONLY"
    && /\/api\/ynap-extension-capture(?:\?|$)/i.test(String(url || ""))
    && options?.body
  ) {
    try {
      const payload = JSON.parse(String(options.body));
      payload.capture = { ...(payload.capture || {}), mode: "STOCK_ONLY" };
      options = { ...options, body: JSON.stringify(payload) };
    } catch {
      // Keep original request; the server will return a useful validation error.
    }
  }
  return jsonRequestBeforeStockRefresh(url, options, timeoutMs);
};

const processJobBeforeStockRefresh = processJob;

processJob = async function processJobWithStockRefresh(s, job) {
  const configs = Array.isArray(job.configs) ? job.configs : [];
  const stockConfigs = configs.filter((config) => (
    String(config?.mode || "").toUpperCase() === "STOCK_ONLY"
    && Array.isArray(config?.directProductUrls)
  ));

  if (!stockConfigs.length) return processJobBeforeStockRefresh(s, job);

  const queue = [];
  const seen = new Set();
  for (const config of stockConfigs) {
    for (const value of config.directProductUrls || []) {
      const url = strictStoneProductUrl(value, value);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      queue.push({ url, config });
    }
  }

  const limit = Math.max(0, Number(job.max_products || 0));
  const selected = limit > 0 ? queue.slice(0, limit) : queue;
  if (!selected.length) throw new Error("No imported Stone Island product links were found for inventory refresh.");

  const previousDone = Math.max(0, Number(job.products_done || 0));
  const previousFailed = Math.max(0, Number(job.errors_count || 0));
  const resumeOffset = Math.min(selected.length, previousDone + previousFailed);
  stats = {
    processed: resumeOffset,
    captured: previousDone,
    failed: previousFailed,
    total: selected.length,
  };

  await queueRequest(s, {
    action: "progress",
    jobId: job.id,
    pagesTotal: 1,
    pagesDone: 1,
    linksFound: selected.length,
    productsTotal: selected.length,
    productsDone: stats.captured,
    productsFailed: stats.failed,
    message: `Inventory refresh prepared for ${selected.length} imported products`,
  });

  for (let index = resumeOffset; index < selected.length; index += 1) {
    if (stopRequested || !(await jobActive(s, job.id))) return;
    const row = selected[index];
    setCurrent(`Updating inventory ${index + 1}/${selected.length}`);

    try {
      parserVoCaptureMode = "STOCK_ONLY";
      const result = await captureProduct(row.url, s, {
        jobId: job.id,
        categoryId: row.config.id,
        gender: row.config.gender,
        category: row.config.category,
        plnRate: row.config.plnRate,
        eurRate: row.config.eurRate,
        defaultQuantity: row.config.defaultQuantity,
        mode: "STOCK_ONLY",
      });

      if (result?.ok) {
        stats.captured += 1;
        log(`Inventory updated ${row.url}`);
      } else {
        stats.failed += 1;
        log(`${row.url}\n${result?.error || "Inventory update failed"}`, true);
      }
    } catch (error) {
      stats.failed += 1;
      log(`${row.url}\n${messageOf(error)}`, true);
    } finally {
      parserVoCaptureMode = "";
      stats.processed += 1;
      await queueRequest(s, {
        action: "progress",
        jobId: job.id,
        pagesTotal: 1,
        pagesDone: 1,
        linksFound: selected.length,
        productsTotal: selected.length,
        productsDone: stats.captured,
        productsFailed: stats.failed,
        message: `Inventory updated ${stats.captured}/${selected.length}; errors ${stats.failed}`,
        result: {
          mode: "STOCK_ONLY",
          version: chrome.runtime.getManifest().version,
          errors: logs.filter((line) => line.includes("ERROR")).slice(0, 20),
        },
      }).catch(() => {});
    }
  }

  if (!stopRequested) {
    await queueRequest(s, {
      action: "complete",
      jobId: job.id,
      pagesTotal: 1,
      pagesDone: 1,
      linksFound: selected.length,
      productsTotal: selected.length,
      productsDone: stats.captured,
      productsFailed: stats.failed,
      message: `Inventory refresh completed ${stats.captured}/${selected.length}; errors ${stats.failed}`,
      result: {
        mode: "STOCK_ONLY",
        version: chrome.runtime.getManifest().version,
        errors: logs.filter((line) => line.includes("ERROR")).slice(0, 20),
      },
    });
  }
};
