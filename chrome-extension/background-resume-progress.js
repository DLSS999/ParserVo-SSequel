// ParserVo Stone Island Capture 2.9.9
// Persist full-import work queues so a Manifest V3 service-worker restart resumes
// from the next unprocessed URL instead of starting the same job from zero.

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

processJob = async function processJobWithPersistentResume(s, job) {
  const configs = Array.isArray(job.configs) ? job.configs : [];
  if (isStockOnlyJob(configs)) return processJobBeforeResumeProgress(s, job);

  const limit = Math.max(0, Number(job.max_products || 0));
  const configMap = new Map(configs.map((config) => [String(config.id || ""), config]));
  const fallbackConfig = configs[0] || null;
  let state = await readResumeState(job.id);

  let queue = Array.isArray(state?.queue)
    ? state.queue
        .map((row) => ({ url: strictStoneProductUrl(row?.url, row?.url), configId: String(row?.configId || "") }))
        .filter((row) => row.url)
    : [];
  let cursor = Math.max(0, Math.min(queue.length, Number(state?.cursor || 0)));
  let captured = Math.max(0, Number(state?.captured || 0));
  let failed = Math.max(0, Number(state?.failed || 0));
  let outOfStock = Math.max(0, Number(state?.outOfStock || 0));
  let pagesDone = Math.max(0, Number(state?.pagesDone || 0));
  let errorMessages = Array.isArray(state?.errors) ? state.errors.slice(0, 50) : [];
  const seen = new Set(queue.map((row) => row.url));

  const configFor = (configId) => configMap.get(String(configId || "")) || fallbackConfig;
  const addWork = (url, config) => {
    const normalized = strictStoneProductUrl(url, config?.catalogUrl || config?.baseUrl || url);
    if (!normalized || seen.has(normalized)) return false;
    if (limit > 0 && queue.length >= limit) return false;
    seen.add(normalized);
    queue.push({ url: normalized, configId: String(config?.id || "") });
    return true;
  };

  const persist = async () => {
    stats = {
      processed: cursor,
      captured,
      failed,
      outOfStock,
      total: queue.length,
    };
    await writeResumeState(job.id, {
      queue,
      cursor,
      captured,
      failed,
      outOfStock,
      pagesDone,
      errors: errorMessages.slice(0, 50),
    });
  };

  if (!queue.length) {
    for (const config of configs) {
      for (const pageUrl of Array.isArray(config.pageUrls) ? config.pageUrls : []) {
        if (stopRequested || !(await jobActive(s, job.id))) {
          await persist();
          return;
        }
        const baseLinks = await collectProductLinks(
          pageUrl,
          limit,
          Number(s.loadWaitMs || 4500),
          Number(config.itemsPerLoad || 16),
        );
        for (const link of baseLinks) addWork(link, config);
        pagesDone += 1;
        await persist();
        await queueRequest(s, {
          action: "progress",
          jobId: job.id,
          pagesTotal: configs.length,
          pagesDone,
          linksFound: queue.length,
          productsTotal: queue.length,
          productsDone: captured,
          productsFailed: failed,
          message: `Prepared ${queue.length} base products; imported ${captured}; not in stock ${outOfStock}; errors ${failed}`,
          result: { resume: true, cursor, outOfStock, version: chrome.runtime.getManifest().version },
        });
      }
    }
  } else {
    setCurrent(`Resuming job ${job.id}: ${cursor}/${queue.length}`);
    log(`Resuming ${job.id} from ${cursor}/${queue.length}; imported ${captured}; not in stock ${outOfStock}; errors ${failed}`);
    await queueRequest(s, {
      action: "progress",
      jobId: job.id,
      pagesTotal: configs.length,
      pagesDone,
      linksFound: queue.length,
      productsTotal: queue.length,
      productsDone: captured,
      productsFailed: failed,
      message: `Resumed ${cursor}/${queue.length}; imported ${captured}; not in stock ${outOfStock}; errors ${failed}`,
      result: { resume: true, cursor, outOfStock, version: chrome.runtime.getManifest().version },
    });
  }

  if (!queue.length) throw new Error("No strict Stone Island product links were found on this catalog page.");

  stats = { processed: cursor, captured, failed, outOfStock, total: queue.length };

  while (cursor < queue.length && (limit <= 0 || cursor < limit)) {
    if (stopRequested || !(await jobActive(s, job.id))) {
      await persist();
      return;
    }

    const row = queue[cursor];
    const config = configFor(row.configId);
    if (!config) throw new Error(`Missing Stone Island configuration for ${row.url}`);
    setCurrent(`Importing ${cursor + 1}/${queue.length}; imported ${captured}; not in stock ${outOfStock}; errors ${failed}`);

    try {
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
    } catch (error) {
      failed += 1;
      const text = `${row.url}\n${messageOf(error)}`;
      errorMessages.unshift(text);
      log(text, true);
    } finally {
      cursor += 1;
      await persist();
      await queueRequest(s, {
        action: "progress",
        jobId: job.id,
        pagesTotal: configs.length,
        pagesDone,
        linksFound: queue.length,
        productsTotal: queue.length,
        productsDone: captured,
        productsFailed: failed,
        message: `Processed ${cursor}/${queue.length}; imported ${captured}; not in stock ${outOfStock}; errors ${failed}`,
        result: {
          resume: true,
          cursor,
          version: chrome.runtime.getManifest().version,
          outOfStock,
          errors: errorMessages.slice(0, 20),
        },
      }).catch(() => {});
    }
  }

  const finalTotal = Math.min(queue.length, limit > 0 ? limit : queue.length);
  await queueRequest(s, {
    action: "complete",
    jobId: job.id,
    pagesTotal: configs.length,
    pagesDone,
    linksFound: queue.length,
    productsTotal: finalTotal,
    productsDone: captured,
    productsFailed: failed,
    message: `Completed ${cursor}/${finalTotal}; imported ${captured}; not in stock ${outOfStock}; errors ${failed}; discovered ${queue.length}`,
    result: {
      resume: true,
      cursor,
      version: chrome.runtime.getManifest().version,
      discovered: queue.length,
      outOfStock,
      errors: errorMessages.slice(0, 20),
    },
  });
  await clearResumeState(job.id);
};
