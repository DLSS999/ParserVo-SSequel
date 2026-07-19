// ParserVo Stone Island Capture 2.10.0
// Resumable imports with NEW_ONLY protection. Existing Shopify products are
// inspected only to discover additional colour URLs and are never re-imported.

const processJobBeforeResumeProgress = processJob;
const RESUME_STATE_PREFIX = "parservo-stone-resume:";

function resumeStateKey(jobId) {
  return `${RESUME_STATE_PREFIX}${String(jobId || "")}`;
}

async function readResumeState(jobId) {
  const key = resumeStateKey(jobId);
  const stored = await chrome.storage.local.get(key);
  const state = stored?.[key];
  return state && state.jobId === jobId ? state : null;
}

async function writeResumeState(jobId, state) {
  const key = resumeStateKey(jobId);
  await chrome.storage.local.set({
    [key]: {
      ...state,
      jobId,
      extensionVersion: chrome.runtime.getManifest().version,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function clearResumeState(jobId) {
  await chrome.storage.local.remove(resumeStateKey(jobId));
}

function isStockOnlyJob(configs) {
  return configs.some((config) => String(config?.mode || "").toUpperCase() === "STOCK_ONLY");
}

function isNewOnlyConfig(config) {
  return String(config?.mode || "").toUpperCase() === "NEW_ONLY";
}

async function parserVoProductExists(settingsValue, sourceUrl) {
  const endpoint = `${normalizeBase(settingsValue.apiBaseUrl)}/api/parservo-product-exists`;
  return jsonRequest(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ParserVo-Token": settingsValue.token,
    },
    body: JSON.stringify({
      shop: clean(settingsValue.shop).toLowerCase(),
      token: settingsValue.token,
      sourceUrl,
    }),
  }, 30000);
}

async function parserVoDiscoverColourVariantsOnly(url, settingsValue) {
  const tab = await chrome.tabs.create({ url, active: true });
  try {
    await waitForTab(tab.id, 60000);
    await sleep(Number(settingsValue.loadWaitMs || 4500));
    return await readStoneProduct(tab.id);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

processJob = async function processJobWithPersistentResume(s, job) {
  const configs = Array.isArray(job.configs) ? job.configs : [];
  if (isStockOnlyJob(configs)) return processJobBeforeResumeProgress(s, job);

  const requestedLimit = Math.max(0, Number(job.max_products || 0));
  const newOnlyJob = configs.some(isNewOnlyConfig);
  const configMap = new Map(configs.map((config) => [String(config.id || ""), config]));
  const fallbackConfig = configs[0] || null;
  const state = await readResumeState(job.id);

  let queue = Array.isArray(state?.queue)
    ? state.queue
        .map((row) => ({
          url: strictStoneProductUrl(row?.url, row?.url),
          configId: String(row?.configId || ""),
        }))
        .filter((row) => row.url)
    : [];
  let cursor = Math.max(0, Math.min(queue.length, Number(state?.cursor || 0)));
  let captured = Math.max(0, Number(state?.captured || 0));
  let failed = Math.max(0, Number(state?.failed || 0));
  let outOfStock = Math.max(0, Number(state?.outOfStock || 0));
  let skippedExisting = Math.max(0, Number(state?.skippedExisting || 0));
  let pagesDone = Math.max(0, Number(state?.pagesDone || 0));
  let errorMessages = Array.isArray(state?.errors) ? state.errors.slice(0, 50) : [];
  const seen = new Set(queue.map((row) => row.url));

  const configFor = (configId) => configMap.get(String(configId || "")) || fallbackConfig;
  const addWork = (url, config) => {
    const normalized = strictStoneProductUrl(url, config?.catalogUrl || config?.baseUrl || url);
    if (!normalized || seen.has(normalized)) return false;
    if (!newOnlyJob && requestedLimit > 0 && queue.length >= requestedLimit) return false;
    seen.add(normalized);
    queue.push({ url: normalized, configId: String(config?.id || "") });
    return true;
  };

  const processedSuccessfully = () => captured + skippedExisting + outOfStock;

  const persist = async () => {
    stats = {
      processed: cursor,
      captured,
      failed,
      outOfStock,
      skippedExisting,
      total: queue.length,
    };
    await writeResumeState(job.id, {
      queue,
      cursor,
      captured,
      failed,
      outOfStock,
      skippedExisting,
      pagesDone,
      errors: errorMessages.slice(0, 50),
    });
  };

  const sendProgress = async (message) => {
    await queueRequest(s, {
      action: "progress",
      jobId: job.id,
      pagesTotal: configs.length,
      pagesDone,
      linksFound: queue.length,
      productsTotal: queue.length,
      productsDone: processedSuccessfully(),
      productsFailed: failed,
      message,
      result: {
        resume: true,
        cursor,
        outOfStock,
        skippedExisting,
        importedNew: captured,
        version: chrome.runtime.getManifest().version,
        errors: errorMessages.slice(0, 20),
      },
    });
  };

  if (!queue.length) {
    for (const config of configs) {
      for (const pageUrl of Array.isArray(config.pageUrls) ? config.pageUrls : []) {
        if (stopRequested || !(await jobActive(s, job.id))) {
          await persist();
          return;
        }

        // NEW_ONLY must inspect the full supplied catalog. Otherwise old products
        // at the beginning of the page would consume the requested new-item limit.
        const collectionLimit = isNewOnlyConfig(config) ? 0 : requestedLimit;
        const baseLinks = await collectProductLinks(
          pageUrl,
          collectionLimit,
          Number(s.loadWaitMs || 4500),
          Number(config.itemsPerLoad || 16),
        );
        for (const link of baseLinks) addWork(link, config);
        pagesDone += 1;
        await persist();
        await sendProgress(
          `Prepared ${queue.length} base products; imported new ${captured}; existing skipped ${skippedExisting}; not in stock ${outOfStock}; errors ${failed}`,
        );
      }
    }
  } else {
    setCurrent(`Resuming job ${job.id}: ${cursor}/${queue.length}`);
    log(
      `Resuming ${job.id} from ${cursor}/${queue.length}; imported new ${captured}; `
      + `existing skipped ${skippedExisting}; not in stock ${outOfStock}; errors ${failed}`,
    );
    await sendProgress(
      `Resumed ${cursor}/${queue.length}; imported new ${captured}; existing skipped ${skippedExisting}; not in stock ${outOfStock}; errors ${failed}`,
    );
  }

  if (!queue.length) throw new Error("No strict Stone Island product links were found on this catalog page.");

  const shouldContinue = () => (
    cursor < queue.length
    && (
      requestedLimit <= 0
      || (newOnlyJob ? captured < requestedLimit : cursor < requestedLimit)
    )
  );

  while (shouldContinue()) {
    if (stopRequested || !(await jobActive(s, job.id))) {
      await persist();
      return;
    }

    const row = queue[cursor];
    const config = configFor(row.configId);
    if (!config) throw new Error(`Missing Stone Island configuration for ${row.url}`);
    setCurrent(
      `Processing ${cursor + 1}/${queue.length}; imported new ${captured}`
      + `${requestedLimit > 0 ? `/${requestedLimit}` : ""}; existing skipped ${skippedExisting}; errors ${failed}`,
    );

    try {
      if (isNewOnlyConfig(config)) {
        const existence = await parserVoProductExists(s, row.url);
        if (existence?.exists) {
          // The existing product itself is never sent to Shopify. We only inspect
          // its colour selector so a new colour of the same model can still enter the queue.
          try {
            const page = await parserVoDiscoverColourVariantsOnly(row.url, s);
            for (const variant of page?.colorVariantUrls || []) addWork(variant.url, config);
          } catch (discoveryError) {
            log(`Existing product colour discovery skipped ${row.url}: ${messageOf(discoveryError)}`);
          }
          skippedExisting += 1;
          log(`Existing product preserved without update ${row.url}; queue now ${queue.length}`);
        } else {
          const result = await captureProduct(row.url, s, {
            jobId: job.id,
            categoryId: config.id,
            gender: config.gender,
            category: config.category,
            plnRate: config.plnRate,
            eurRate: config.eurRate,
            defaultQuantity: config.defaultQuantity,
          });
          for (const variant of result?.page?.colorVariantUrls || []) addWork(variant.url, config);

          if (result?.ok && result?.skipped && result?.reason === "OUT_OF_STOCK") {
            outOfStock += 1;
            log(`Not in stock ${row.url}; queue now ${queue.length}`);
          } else if (result?.ok) {
            captured += 1;
            log(`Imported new product ${row.url}; queue now ${queue.length}`);
          } else {
            failed += 1;
            const text = `${row.url}\n${result?.error || "Unknown product import error"}`;
            errorMessages.unshift(text);
            log(text, true);
          }
        }
      } else {
        const result = await captureProduct(row.url, s, {
          jobId: job.id,
          categoryId: config.id,
          gender: config.gender,
          category: config.category,
          plnRate: config.plnRate,
          eurRate: config.eurRate,
          defaultQuantity: config.defaultQuantity,
        });
        for (const variant of result?.page?.colorVariantUrls || []) addWork(variant.url, config);

        if (result?.ok && result?.skipped && result?.reason === "OUT_OF_STOCK") {
          outOfStock += 1;
          log(`Not in stock ${row.url}; queue now ${queue.length}`);
        } else if (result?.ok) {
          captured += 1;
          log(`Imported ${row.url}; queue now ${queue.length}`);
        } else {
          failed += 1;
          const text = `${row.url}\n${result?.error || "Unknown product import error"}`;
          errorMessages.unshift(text);
          log(text, true);
        }
      }
    } catch (error) {
      failed += 1;
      const text = `${row.url}\n${messageOf(error)}`;
      errorMessages.unshift(text);
      log(text, true);
    } finally {
      cursor += 1;
      await persist();
      await sendProgress(
        `Processed ${cursor}/${queue.length}; imported new ${captured}`
        + `${requestedLimit > 0 ? `/${requestedLimit}` : ""}; existing skipped ${skippedExisting}; `
        + `not in stock ${outOfStock}; errors ${failed}`,
      ).catch(() => {});
    }
  }

  await queueRequest(s, {
    action: "complete",
    jobId: job.id,
    pagesTotal: configs.length,
    pagesDone,
    linksFound: queue.length,
    productsTotal: queue.length,
    productsDone: processedSuccessfully(),
    productsFailed: failed,
    message: `Completed: imported new ${captured}`
      + `${requestedLimit > 0 ? `/${requestedLimit}` : ""}; existing skipped ${skippedExisting}; `
      + `not in stock ${outOfStock}; errors ${failed}; discovered ${queue.length}`,
    result: {
      resume: true,
      cursor,
      version: chrome.runtime.getManifest().version,
      discovered: queue.length,
      importedNew: captured,
      outOfStock,
      skippedExisting,
      errors: errorMessages.slice(0, 20),
    },
  });
  await clearResumeState(job.id);
};
