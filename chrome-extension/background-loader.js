importScripts("background.js");

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let lastCatalogVariantTotal = 0;

queueRequest = async function queueRequestWithManifestVersion(s, payload, timeoutMs = 60000) {
  const { queue } = endpoints(s);
  return jsonRequest(queue, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ParserVo-Token": s.token },
    body: JSON.stringify({
      shop: clean(s.shop).toLowerCase(),
      token: s.token,
      agentId: "stone-island-chrome",
      version: EXTENSION_VERSION,
      ...payload,
    }),
  }, timeoutMs);
};

function colorVariantUrl(productUrl, colorCode) {
  try {
    const url = new URL(productUrl);
    const value = String(colorCode || "").trim().toUpperCase();
    if (!/^V[A-Z0-9]+$/.test(value)) return null;
    if (!/V[A-Z0-9]+\.html?$/i.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/V[A-Z0-9]+(\.html?)$/i, `${value}$1`);
    url.search = "";
    url.hash = "";
    return strictStoneProductUrl(url.toString(), productUrl);
  } catch {
    return null;
  }
}

collectProductLinks = async function collectBaseProductLinks(catalogUrl, limit, loadWaitMs) {
  let tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  const allLinks = new Set();
  let pageTotal = 0;
  let successfulClicks = 0;
  let reloads = 0;
  let lastSnapshot = null;

  const ensureCatalogTab = async () => {
    try {
      await chrome.tabs.get(tab.id);
    } catch {
      tab = await chrome.tabs.create({ url: catalogUrl, active: true });
      reloads += 1;
      await waitForTab(tab.id, 60000);
      await sleep(Math.max(5000, Number(loadWaitMs || 4500)));
    }
  };

  const snapshot = async () => {
    await ensureCatalogTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalizeProductUrl = (candidate) => {
          try {
            const url = new URL(String(candidate || ""), location.href);
            if (!/(^|\.)stoneisland\.com$/i.test(url.hostname)) return null;
            if (!/\/collection\//i.test(url.pathname)) return null;
            if (!/-L[A-Z0-9]{12,}\.html?$/i.test(url.pathname)) return null;
            url.search = "";
            url.hash = "";
            return url.toString();
          } catch {
            return null;
          }
        };

        const links = new Set();
        const add = (candidate) => {
          const normalized = normalizeProductUrl(candidate);
          if (normalized) links.add(normalized);
        };

        for (const node of document.querySelectorAll(
          "a.product-tile__link[href], a[href], [data-url], [data-href], [data-product-url], [data-product-link]",
        )) {
          for (const name of ["href", "data-url", "data-href", "data-product-url", "data-product-link"]) {
            add(node.getAttribute(name));
          }
        }

        const html = (document.documentElement?.innerHTML || "")
          .replace(/\\u002[fF]/g, "/")
          .replace(/\\\//g, "/")
          .replace(/&amp;/g, "&");
        const patterns = [
          /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi,
          /["'](\/[a-z]{2}-[a-z]{2}\/collection\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?)["']/gi,
        ];
        for (const pattern of patterns) {
          for (const match of html.matchAll(pattern)) add(match[1] || match[0]);
        }

        const bodyText = cleanText(document.body?.innerText || "");
        const totals = [];
        for (const match of bodyText.matchAll(/\b([0-9][0-9\s.,]*)\s+(?:products?|results?|items?)\b/gi)) {
          const value = Number(String(match[1]).replace(/[\s.,]/g, ""));
          if (Number.isFinite(value) && value > 0 && value < 10000) totals.push(value);
        }

        const loadMore = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => {
          const label = cleanText(
            node.textContent
            || node.getAttribute("value")
            || node.getAttribute("aria-label")
            || node.getAttribute("title")
            || "",
          );
          return /^load\s+more(?:\s+products?)?$/i.test(label);
        }) || null;

        return {
          url: location.href,
          title: document.title || "",
          bodySnippet: bodyText.slice(0, 500),
          links: [...links],
          pageTotal: totals.length ? Math.max(...totals) : 0,
          hasLoadMore: Boolean(loadMore),
          loadMoreDisabled: Boolean(loadMore?.disabled || loadMore?.getAttribute("aria-disabled") === "true"),
        };
      },
    });

    const value = injected?.[0]?.result || null;
    if (!value) throw new Error("Stone Island catalog snapshot returned no data.");
    lastSnapshot = value;
    for (const link of value.links || []) {
      const normalized = strictStoneProductUrl(link, catalogUrl);
      if (normalized) allLinks.add(normalized);
    }
    if (Number(value.pageTotal) > pageTotal) pageTotal = Number(value.pageTotal);
    lastCatalogVariantTotal = pageTotal;
    return value;
  };

  const clickLoadMore = async () => {
    await ensureCatalogTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const button = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => {
          const label = cleanText(
            node.textContent
            || node.getAttribute("value")
            || node.getAttribute("aria-label")
            || node.getAttribute("title")
            || "",
          );
          return /^load\s+more(?:\s+products?)?$/i.test(label);
        });
        if (!button) return { clicked: false, reason: "missing" };
        if (button.disabled || button.getAttribute("aria-disabled") === "true") {
          return { clicked: false, reason: "disabled" };
        }
        button.scrollIntoView({ block: "center", behavior: "auto" });
        button.click();
        return { clicked: true, reason: "clicked" };
      },
    });
    return injected?.[0]?.result || { clicked: false, reason: "no-result" };
  };

  try {
    await waitForTab(tab.id, 60000);
    await sleep(Math.max(3000, Number(loadWaitMs || 4500)));

    let initialDeadline = Date.now() + 90000;
    while (Date.now() < initialDeadline && allLinks.size === 0) {
      await snapshot();
      if (allLinks.size > 0) break;
      await sleep(1000);
    }

    if (allLinks.size === 0) {
      reloads += 1;
      await chrome.tabs.reload(tab.id);
      await waitForTab(tab.id, 60000);
      await sleep(Math.max(5000, Number(loadWaitMs || 4500)));
      initialDeadline = Date.now() + 60000;
      while (Date.now() < initialDeadline && allLinks.size === 0) {
        await snapshot();
        if (allLinks.size > 0) break;
        await sleep(1000);
      }
    }

    if (allLinks.size === 0) {
      throw new Error(
        `Stone Island catalog loaded without product links. URL: ${lastSnapshot?.url || catalogUrl}; `
        + `title: ${lastSnapshot?.title || "unknown"}; page text: ${lastSnapshot?.bodySnippet || "empty"}`,
      );
    }

    let stableRounds = 0;
    for (let round = 0; round < 700; round += 1) {
      const requested = Math.max(0, Number(limit || 0));
      if (requested > 0 && allLinks.size >= requested) break;

      const before = allLinks.size;
      const currentSnapshot = await snapshot();
      setCurrent(`Loading base products ${allLinks.size}; catalog variants ${pageTotal || "?"}`);

      if (!currentSnapshot.hasLoadMore || currentSnapshot.loadMoreDisabled) {
        stableRounds += 1;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.scrollTo(0, Math.max(0, document.body.scrollHeight - 300)),
        }).catch(() => {});
        await sleep(1500);
        await snapshot();
        if (allLinks.size > before) stableRounds = 0;
        if (stableRounds >= 12) break;
        continue;
      }

      const clicked = await clickLoadMore();
      if (!clicked.clicked) {
        stableRounds += 1;
        await sleep(1200);
        if (stableRounds >= 12) break;
        continue;
      }

      const deadline = Date.now() + 45000;
      let grew = false;
      while (Date.now() < deadline) {
        await sleep(750);
        await snapshot();
        if (allLinks.size > before) {
          grew = true;
          successfulClicks += 1;
          break;
        }
      }
      stableRounds = grew ? 0 : stableRounds + 1;
      if (stableRounds >= 12) break;
    }

    log(
      `Catalog loader ${EXTENSION_VERSION}: found ${allLinks.size} base products for `
      + `${pageTotal || "?"} catalog colour variants; LOAD MORE clicks ${successfulClicks}; reloads ${reloads}`,
    );

    return [...allLinks].slice(0, Number(limit || 0) > 0 ? Number(limit) : undefined);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
};

const legacyReadStoneProduct = readStoneProduct;
readStoneProduct = async function readStoneProductWithColourVariants(tabId) {
  const page = await legacyReadStoneProduct(tabId);
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && document.querySelectorAll('#pdp-colorSelector input[type="radio"][value]').length === 0) {
        await wait(250);
      }

      const current = new URL(location.href);
      const variants = [];
      const seen = new Set();
      for (const input of document.querySelectorAll('#pdp-colorSelector input[type="radio"][value], .product-selection__selectors input[type="radio"][value]')) {
        const code = String(input.value || "").trim().toUpperCase();
        if (!/^V[A-Z0-9]+$/.test(code)) continue;
        const url = new URL(current.toString());
        if (!/V[A-Z0-9]+\.html?$/i.test(url.pathname)) continue;
        url.pathname = url.pathname.replace(/V[A-Z0-9]+(\.html?)$/i, `${code}$1`);
        url.search = "";
        url.hash = "";
        const href = url.toString();
        if (seen.has(href)) continue;
        seen.add(href);
        variants.push({
          url: href,
          code,
          color: String(input.getAttribute("aria-label") || "").trim(),
        });
      }
      return variants;
    },
  });

  const variants = Array.isArray(injected?.[0]?.result) ? injected[0].result : [];
  page.colorVariantUrls = variants
    .map((variant) => ({
      ...variant,
      url: strictStoneProductUrl(variant.url, page.url),
    }))
    .filter((variant) => variant.url);

  if (!page.colorVariantUrls.some((variant) => variant.url === page.url)) {
    page.colorVariantUrls.unshift({ url: page.url, code: page.productCode.match(/V[A-Z0-9]+$/i)?.[0] || "", color: page.color });
  }
  return page;
};

captureProduct = async function captureProductWithColourDiscovery(url, s, context) {
  const tab = await chrome.tabs.create({ url, active: true });
  try {
    await waitForTab(tab.id, 60000);
    await sleep(Number(s.loadWaitMs || 4500));
    const page = await readStoneProduct(tab.id);
    const { capture } = endpoints(s);
    const payload = {
      shop: clean(s.shop).toLowerCase(),
      token: s.token,
      agentId: "stone-island-chrome",
      version: EXTENSION_VERSION,
      capture: {
        jobId: context.jobId,
        categoryId: context.categoryId,
        source: "STONE_ISLAND",
        gender: context.gender || "MEN",
        category: context.category || "Catalog",
        ...page,
        defaultQuantity: context.defaultQuantity,
        rates: { pln: context.plnRate || s.plnRate, eur: context.eurRate || s.eurRate },
      },
    };

    try {
      const apiResult = await jsonRequest(capture, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ParserVo-Token": s.token },
        body: JSON.stringify(payload),
      }, 150000);
      return { ok: true, page, apiResult, error: null };
    } catch (error) {
      return { ok: false, page, apiResult: null, error: messageOf(error) };
    }
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
};

processJob = async function processJobWithColourExpansion(s, job) {
  const configs = Array.isArray(job.configs) ? job.configs : [];
  const limit = Math.max(0, Number(job.max_products || 0));
  const queue = [];
  const seen = new Set();
  let pagesDone = 0;

  const addWork = (url, config) => {
    const normalized = strictStoneProductUrl(url, config?.catalogUrl || config?.baseUrl || url);
    if (!normalized || seen.has(normalized)) return false;
    if (limit > 0 && queue.length >= limit) return false;
    seen.add(normalized);
    queue.push({ url: normalized, config });
    return true;
  };

  for (const config of configs) {
    for (const pageUrl of Array.isArray(config.pageUrls) ? config.pageUrls : []) {
      if (stopRequested || !(await jobActive(s, job.id))) return;
      const links = await collectProductLinks(pageUrl, limit, Number(s.loadWaitMs || 4500));
      for (const link of links) addWork(link, config);
      pagesDone += 1;
      await queueRequest(s, {
        action: "progress",
        jobId: job.id,
        pagesTotal: configs.length,
        pagesDone,
        linksFound: queue.length,
        productsTotal: limit || lastCatalogVariantTotal || queue.length,
        productsDone: stats.captured,
        productsFailed: stats.failed,
        message: `Found ${queue.length} base products; expanding ${lastCatalogVariantTotal || limit || "?"} colour variants`,
      });
    }
  }

  if (!queue.length) throw new Error("No strict Stone Island product links were found on this catalog page.");

  stats.total = limit || lastCatalogVariantTotal || queue.length;
  let cursor = 0;
  while (cursor < queue.length && (limit <= 0 || cursor < limit)) {
    if (stopRequested || !(await jobActive(s, job.id))) return;
    const row = queue[cursor];
    cursor += 1;
    setCurrent(`Importing ${cursor}/${limit || queue.length}; discovered ${queue.length}`);

    try {
      const result = await captureProduct(row.url, s, {
        jobId: job.id,
        categoryId: row.config.id,
        gender: row.config.gender,
        category: row.config.category,
        plnRate: row.config.plnRate,
        eurRate: row.config.eurRate,
        defaultQuantity: row.config.defaultQuantity,
      });

      for (const variant of result.page?.colorVariantUrls || []) {
        addWork(variant.url, row.config);
      }

      if (result.ok) {
        stats.captured += 1;
        log(`Imported ${row.url}; discovered ${result.page?.colorVariantUrls?.length || 1} colours`);
      } else {
        stats.failed += 1;
        log(`${row.url}\n${result.error}`, true);
      }
    } catch (error) {
      stats.failed += 1;
      log(`${row.url}\n${messageOf(error)}`, true);
    } finally {
      stats.processed += 1;
      stats.total = limit || Math.max(queue.length, lastCatalogVariantTotal || 0);
      await queueRequest(s, {
        action: "progress",
        jobId: job.id,
        pagesTotal: configs.length,
        pagesDone,
        linksFound: queue.length,
        productsTotal: stats.total,
        productsDone: stats.captured,
        productsFailed: stats.failed,
        message: `Discovered ${queue.length}/${limit || lastCatalogVariantTotal || queue.length}; imported ${stats.captured}; errors ${stats.failed}`,
        result: { errors: logs.filter((line) => line.includes("ERROR")).slice(0, 20) },
      }).catch(() => {});
    }
  }

  const expected = limit || lastCatalogVariantTotal || queue.length;
  if (expected > 0 && queue.length < expected) {
    throw new Error(
      `Stone Island colour expansion is incomplete: discovered ${queue.length} of ${expected} variants `
      + `from the loaded base products.`,
    );
  }

  if (!stopRequested) {
    await queueRequest(s, {
      action: "complete",
      jobId: job.id,
      pagesTotal: configs.length,
      pagesDone,
      linksFound: queue.length,
      productsTotal: expected,
      productsDone: stats.captured,
      productsFailed: stats.failed,
      message: `Completed ${stats.captured}/${expected}; errors ${stats.failed}; colour variants discovered ${queue.length}`,
      result: { version: EXTENSION_VERSION, catalogVariantTotal: lastCatalogVariantTotal },
    });
  }
};
