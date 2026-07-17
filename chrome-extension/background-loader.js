importScripts("background.js");

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let catalogVariantTotal = 0;

queueRequest = async function queueRequestV28(s, payload, timeoutMs = 60000) {
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

collectProductLinks = async function collectStoneIslandBaseLinks(catalogUrl, limit, loadWaitMs, itemsPerLoad = 16) {
  const batchSize = Math.max(1, Math.min(200, Math.trunc(Number(itemsPerLoad || 16))));
  const requestedTotal = Math.max(0, Math.trunc(Number(limit || 0)));
  const requiredClicks = () => {
    const target = requestedTotal || catalogVariantTotal || 0;
    return target > 0 ? Math.max(0, Math.ceil(target / batchSize) - 1) : 0;
  };
  let tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  const links = new Set();
  let loadMoreClicks = 0;
  let reloads = 0;

  const ensureTab = async () => {
    try {
      await chrome.tabs.get(tab.id);
    } catch {
      tab = await chrome.tabs.create({ url: catalogUrl, active: true });
      reloads += 1;
      await waitForTab(tab.id, 60000);
      await sleep(Math.max(4500, Number(loadWaitMs || 4500)));
    }
  };

  const snapshot = async () => {
    await ensureTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalize = (value) => {
          try {
            const url = new URL(String(value || ""), location.href);
            if (!/(^|\.)stoneisland\.com$/i.test(url.hostname)) return null;
            if (!/\/collection\/.+-L[A-Z0-9]{12,}\.html?$/i.test(url.pathname)) return null;
            url.search = "";
            url.hash = "";
            return url.toString();
          } catch {
            return null;
          }
        };

        const found = new Set();
        const add = (value) => {
          const normalized = normalize(value);
          if (normalized) found.add(normalized);
        };

        for (const node of document.querySelectorAll(
          "a.product-tile__link[href], a[href], [data-url], [data-href], [data-product-url]",
        )) {
          for (const name of ["href", "data-url", "data-href", "data-product-url"]) {
            add(node.getAttribute(name));
          }
        }

        const html = (document.documentElement?.innerHTML || "")
          .replace(/\\u002[fF]/g, "/")
          .replace(/\\\//g, "/")
          .replace(/&amp;/g, "&");
        const absolute = /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi;
        const relative = /["'](\/[a-z]{2}-[a-z]{2}\/collection\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?)["']/gi;
        for (const match of html.matchAll(absolute)) add(match[0]);
        for (const match of html.matchAll(relative)) add(match[1]);

        const body = text(document.body?.innerText || "");
        const totals = [];
        for (const match of body.matchAll(/\b([0-9][0-9\s.,]*)\s+(?:products?|results?|items?)\b/gi)) {
          const number = Number(String(match[1]).replace(/[\s.,]/g, ""));
          if (Number.isFinite(number) && number > 0 && number < 10000) totals.push(number);
        }

        const loadMore = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => /^load\s+more(?:\s+products?)?$/i.test(text(
          node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || node.getAttribute("title"),
        ))) || null;

        return {
          url: location.href,
          title: document.title || "",
          links: [...found],
          total: totals.length ? Math.max(...totals) : 0,
          hasLoadMore: Boolean(loadMore),
          disabled: Boolean(loadMore?.disabled || loadMore?.getAttribute("aria-disabled") === "true"),
        };
      },
    });

    const result = injected?.[0]?.result;
    if (!result) throw new Error("Stone Island catalog snapshot returned no data.");
    for (const value of result.links || []) {
      const normalized = strictStoneProductUrl(value, catalogUrl);
      if (normalized) links.add(normalized);
    }
    if (Number(result.total) > catalogVariantTotal) catalogVariantTotal = Number(result.total);
    return result;
  };

  const clickLoadMore = async () => {
    await ensureTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const button = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => /^load\s+more(?:\s+products?)?$/i.test(text(
          node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || node.getAttribute("title"),
        )));
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        button.scrollIntoView({ block: "center", behavior: "auto" });
        try {
          button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        } catch {}
        button.click();
        return true;
      },
    });
    return Boolean(injected?.[0]?.result);
  };

  try {
    await waitForTab(tab.id, 60000);
    await sleep(Math.max(3000, Number(loadWaitMs || 4500)));

    let initialDeadline = Date.now() + 90000;
    while (Date.now() < initialDeadline && links.size === 0) {
      await snapshot();
      if (links.size > 0) break;
      await sleep(1000);
    }
    if (links.size === 0) {
      await chrome.tabs.reload(tab.id);
      reloads += 1;
      await waitForTab(tab.id, 60000);
      await sleep(Math.max(5000, Number(loadWaitMs || 4500)));
      initialDeadline = Date.now() + 60000;
      while (Date.now() < initialDeadline && links.size === 0) {
        await snapshot();
        if (links.size > 0) break;
        await sleep(1000);
      }
    }
    if (links.size === 0) throw new Error("No strict Stone Island product links were found on this catalog page.");

    let stable = 0;
    for (let round = 0; round < 700; round += 1) {
      if (requestedTotal > 0 && links.size >= requestedTotal) break;
      const before = links.size;
      const state = await snapshot();
      setCurrent(`Loading base products ${links.size}; catalog colour variants ${catalogVariantTotal || "?"}`);

      if (!state.hasLoadMore || state.disabled) {
        stable += 1;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.scrollTo(0, Math.max(0, document.body.scrollHeight - 300)),
        }).catch(() => {});
        await sleep(1500);
        await snapshot();
        if (links.size > before) stable = 0;
        const stableLimit = loadMoreClicks < requiredClicks() ? 40 : 12;
        if (stable >= stableLimit) {
          if (loadMoreClicks < requiredClicks()) {
            throw new Error(
              `LOAD MORE stopped after ${loadMoreClicks} of ${requiredClicks()} required clicks. `
              + `Found ${links.size} links; batch size ${batchSize}.`,
            );
          }
          break;
        }
        continue;
      }

      if (!(await clickLoadMore())) {
        stable += 1;
        const stableLimit = loadMoreClicks < requiredClicks() ? 40 : 12;
        if (stable >= stableLimit) {
          if (loadMoreClicks < requiredClicks()) {
            throw new Error(
              `LOAD MORE click failed after ${loadMoreClicks} of ${requiredClicks()} required clicks. `
              + `Found ${links.size} links; batch size ${batchSize}.`,
            );
          }
          break;
        }
        await sleep(1200);
        continue;
      }

      const deadline = Date.now() + 45000;
      let grew = false;
      while (Date.now() < deadline) {
        await sleep(750);
        await snapshot();
        if (links.size > before) {
          grew = true;
          loadMoreClicks += 1;
          break;
        }
      }
      stable = grew ? 0 : stable + 1;
      const stableLimit = loadMoreClicks < requiredClicks() ? 40 : 12;
      if (stable >= stableLimit) {
        if (loadMoreClicks < requiredClicks()) {
          throw new Error(
            `Catalog stopped growing after ${loadMoreClicks} of ${requiredClicks()} required LOAD MORE clicks. `
            + `Found ${links.size} links; batch size ${batchSize}.`,
          );
        }
        break;
      }
    }

    log(
      `Catalog ${EXTENSION_VERSION}: ${links.size} base products, ${catalogVariantTotal || "?"} colour variants, `
      + `${loadMoreClicks}/${requiredClicks()} LOAD MORE clicks, batch ${batchSize}, ${reloads} reloads`,
    );
    return [...links].slice(0, Number(limit || 0) > 0 ? Number(limit) : undefined);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
};

const legacyReadStoneProduct = readStoneProduct;
readStoneProduct = async function readStoneProductV28(tabId) {
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
      for (const input of document.querySelectorAll(
        '#pdp-colorSelector input[type="radio"][value], .product-selection__selectors input[type="radio"][value]',
      )) {
        const code = String(input.value || "").trim().toUpperCase();
        if (!/^V[A-Z0-9]+$/.test(code)) continue;
        const url = new URL(current.toString());
        if (!/V[A-Z0-9]+\.html?$/i.test(url.pathname)) continue;
        url.pathname = url.pathname.replace(/V[A-Z0-9]+(\.html?)$/i, `${code}$1`);
        url.search = "";
        url.hash = "";
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        variants.push({ url: url.href, code, color: String(input.getAttribute("aria-label") || "").trim() });
      }
      return variants;
    },
  });
  page.colorVariantUrls = (Array.isArray(injected?.[0]?.result) ? injected[0].result : [])
    .map((item) => ({ ...item, url: strictStoneProductUrl(item.url, page.url) }))
    .filter((item) => item.url);
  if (!page.colorVariantUrls.some((item) => item.url === page.url)) {
    page.colorVariantUrls.unshift({ url: page.url, color: page.color, code: page.productCode.match(/V[A-Z0-9]+$/i)?.[0] || "" });
  }
  return page;
};

captureProduct = async function captureProductV28(url, s, context) {
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

processJob = async function processJobV28(s, job) {
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
      const baseLinks = await collectProductLinks(
        pageUrl,
        limit,
        Number(s.loadWaitMs || 4500),
        Number(config.itemsPerLoad || 16),
      );
      for (const link of baseLinks) addWork(link, config);
      pagesDone += 1;
      await queueRequest(s, {
        action: "progress",
        jobId: job.id,
        pagesTotal: configs.length,
        pagesDone,
        linksFound: queue.length,
        productsTotal: limit || catalogVariantTotal || queue.length,
        productsDone: stats.captured,
        productsFailed: stats.failed,
        message: `Found ${queue.length} base products; expanding colour variants`,
      });
    }
  }

  if (!queue.length) throw new Error("No strict Stone Island product links were found on this catalog page.");
  stats.total = limit || catalogVariantTotal || queue.length;

  let cursor = 0;
  while (cursor < queue.length && (limit <= 0 || cursor < limit)) {
    if (stopRequested || !(await jobActive(s, job.id))) return;
    const row = queue[cursor++];
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
      for (const variant of result.page?.colorVariantUrls || []) addWork(variant.url, row.config);
      if (result.ok) {
        stats.captured += 1;
        log(`Imported ${row.url}; ${result.page?.colorVariantUrls?.length || 1} colour variants found`);
      } else {
        stats.failed += 1;
        log(`${row.url}\n${result.error}`, true);
      }
    } catch (error) {
      stats.failed += 1;
      log(`${row.url}\n${messageOf(error)}`, true);
    } finally {
      stats.processed += 1;
      stats.total = limit || Math.max(queue.length, catalogVariantTotal || 0);
      await queueRequest(s, {
        action: "progress",
        jobId: job.id,
        pagesTotal: configs.length,
        pagesDone,
        linksFound: queue.length,
        productsTotal: stats.total,
        productsDone: stats.captured,
        productsFailed: stats.failed,
        message: `Discovered ${queue.length}/${limit || catalogVariantTotal || queue.length}; imported ${stats.captured}; errors ${stats.failed}`,
        result: { errors: logs.filter((line) => line.includes("ERROR")).slice(0, 20) },
      }).catch(() => {});
    }
  }

  const expected = limit || catalogVariantTotal || queue.length;
  if (expected > 0 && queue.length < expected) {
    throw new Error(`Stone Island colour expansion is incomplete: discovered ${queue.length} of ${expected} variants.`);
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
      message: `Completed ${stats.captured}/${expected}; errors ${stats.failed}; colour variants ${queue.length}`,
      result: { version: EXTENSION_VERSION, catalogVariantTotal },
    });
  }
};
