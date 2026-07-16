const VERSION = "2.4.0";
const ALARM = "parservo-stone-island-poll";
const DEFAULTS = {
  apiBaseUrl: "https://parser-vo-s-sequel.vercel.app",
  shop: "",
  token: "",
  plnRate: "12.19",
  eurRate: "55",
  loadWaitMs: 4500,
  autoQueue: true,
};

let running = false;
let stopRequested = false;
let current = "Idle";
let logs = [];
let stats = { processed: 0, captured: 0, failed: 0, total: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const messageOf = (error) => error instanceof Error ? error.message : String(error);
const log = (message, error = false) => {
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${error ? "ERROR" : "INFO"}: ${message}`);
  logs = logs.slice(0, 100);
};
const setCurrent = (value) => { current = value; };
const normalizeBase = (value) => String(value || "").trim().replace(/\/+$/, "");

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored, apiBaseUrl: normalizeBase(stored.apiBaseUrl || DEFAULTS.apiBaseUrl) };
}

function endpoints(value) {
  const base = normalizeBase(value.apiBaseUrl);
  return {
    queue: `${base}/api/ynap-extension-queue`,
    capture: `${base}/api/ynap-extension-capture`,
  };
}

function validate(value) {
  const s = { ...value, apiBaseUrl: normalizeBase(value.apiBaseUrl) };
  if (!/^https?:\/\//i.test(s.apiBaseUrl)) throw new Error("API Base URL is invalid.");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(clean(s.shop))) throw new Error("Shop must end with .myshopify.com.");
  if (!clean(s.token)) throw new Error("Browser Capture Token is empty.");
  return s;
}

async function jsonRequest(url, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 250)}`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function queueRequest(s, payload, timeoutMs = 60000) {
  const { queue } = endpoints(s);
  return jsonRequest(queue, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ParserVo-Token": s.token },
    body: JSON.stringify({ shop: clean(s.shop).toLowerCase(), token: s.token, agentId: "stone-island-chrome", version: VERSION, ...payload }),
  }, timeoutMs);
}

async function heartbeat(status = "ONLINE", message = "Waiting for ParserVo jobs", jobId = null) {
  const s = validate(await settings());
  return queueRequest(s, { action: "heartbeat", status, message, jobId }, 20000);
}

async function waitForTab(tabId, timeoutMs = 35000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(250);
  }
  throw new Error("Page load timed out.");
}

function strictStoneProductUrl(candidate, baseUrl) {
  try {
    const url = new URL(String(candidate || ""), baseUrl);
    if (!/(^|\.)stoneisland\.com$/i.test(url.hostname)) return null;
    if (!/\/collection\/.+-L[A-Z0-9]{12,}\.html?$/i.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function collectProductLinks(catalogUrl, limit, loadWaitMs) {
  const tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  try {
    await waitForTab(tab.id);
    await sleep(loadWaitMs);
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [catalogUrl, Math.max(0, Number(limit || 0))],
      func: async (baseUrl, maxLinks) => {
        const sleepPage = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const strict = (candidate) => {
          try {
            const url = new URL(String(candidate || ""), baseUrl);
            if (!/(^|\.)stoneisland\.com$/i.test(url.hostname)) return null;
            if (!/\/collection\/.+-L[A-Z0-9]{12,}\.html?$/i.test(url.pathname)) return null;
            url.search = "";
            url.hash = "";
            return url.toString();
          } catch { return null; }
        };
        let stable = 0;
        let previous = 0;
        for (let i = 0; i < 24 && stable < 4; i += 1) {
          window.scrollTo(0, document.body.scrollHeight);
          await sleepPage(500);
          const height = document.body.scrollHeight;
          if (height === previous) stable += 1; else stable = 0;
          previous = height;
        }
        const links = new Set();
        const add = (value) => {
          const url = strict(value);
          if (url) links.add(url);
          return maxLinks > 0 && links.size >= maxLinks;
        };
        for (const node of document.querySelectorAll("a[href], [data-url], [data-href], [data-product-url]")) {
          for (const name of ["href", "data-url", "data-href", "data-product-url"]) {
            if (add(node.getAttribute(name))) return [...links];
          }
        }
        const html = (document.documentElement.innerHTML || "")
          .replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
        const pattern = /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi;
        for (const match of html.matchAll(pattern)) {
          if (add(match[0])) break;
        }
        return [...links];
      },
    });
    const values = injected?.[0]?.result || [];
    return [...new Set(values.map((value) => strictStoneProductUrl(value, catalogUrl)).filter(Boolean))].slice(0, limit > 0 ? limit : undefined);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function readStoneProduct(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const absolute = (value) => { try { return new URL(value, location.href).href; } catch { return ""; } };
      const bodyText = document.body?.innerText || "";
      const pageHtml = document.documentElement?.outerHTML || "";

      const ldRows = [];
      for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(node.textContent || "null");
          if (Array.isArray(parsed)) ldRows.push(...parsed);
          else if (parsed?.["@graph"]) ldRows.push(parsed, ...parsed["@graph"]);
          else if (parsed) ldRows.push(parsed);
        } catch {}
      }
      const productLd = ldRows.find((row) => row?.["@type"] === "Product" || (Array.isArray(row?.["@type"]) && row["@type"].includes("Product"))) || {};
      const offer = Array.isArray(productLd.offers) ? productLd.offers[0] || {} : productLd.offers || {};

      const filename = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
      const productCode = (filename.match(/(?:^|-)(L[A-Z0-9]{12,})\.html?$/i)?.[1] || "").toUpperCase();
      const title = cleanText(document.querySelector("h1")?.textContent || productLd.name || document.title)
        .replace(/\s*\|\s*Stone Island.*$/i, "").replace(/^STONE ISLAND\s+/i, "");
      const selected = document.querySelector('#pdp-colorSelector input[type="radio"]:checked');
      const color = cleanText(
        document.querySelector('.product-selection__selectors .selector-color .selector__label__value')?.textContent ||
        selected?.getAttribute("aria-label") || productLd.color || ""
      ).replace(/^colou?r\s*:\s*/i, "");

      const hiddenPrice = cleanText(
        document.querySelector('.product-selection__price .visually-hidden')?.textContent ||
        document.querySelector('.sticky-tray__price .visually-hidden')?.textContent || ""
      );
      const priceText = hiddenPrice || cleanText(document.querySelector('.product-selection__price')?.textContent || "");
      const pair = priceText.match(/Original price\s*(?:PLN|zł|€|EUR|£|GBP|\$|USD)?\s*([\d\s.,]+)\s*,?\s*current price\s*(?:PLN|zł|€|EUR|£|GBP|\$|USD)?\s*([\d\s.,]+)/i);
      const money = [...priceText.matchAll(/(?:PLN|zł|€|EUR|£|GBP|\$|USD)\s*[\d\s.,]+|[\d\s.,]+\s*(?:PLN|zł|€|EUR|£|GBP|\$|USD)/gi)].map((m) => cleanText(m[0]));
      const price = pair?.[2] || offer.price || money.at(-1) || "";
      const compareAtPrice = pair?.[1] || (money.length > 1 ? money[0] : null);
      const currency = cleanText(offer.priceCurrency) || (/PLN|zł/i.test(priceText) ? "PLN" : /EUR|€/i.test(priceText) ? "EUR" : /GBP|£/i.test(priceText) ? "GBP" : "PLN");

      const sizeButton = document.querySelector('#sizes-combobox, [aria-controls="PDP-size-selector-options"], .selector-size-dropdown__button');
      if (sizeButton) {
        try { sizeButton.scrollIntoView({ block: "center" }); await wait(200); if (sizeButton.getAttribute("aria-expanded") !== "true") sizeButton.click(); } catch {}
      }
      const sizeSelector = '#PDP-size-selector-options [role="option"], #PDP-size-selector-options button, #PDP-size-selector-options label, [role="listbox"] [role="option"], select option';
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && document.querySelectorAll(sizeSelector).length === 0) await wait(250);
      const sizes = [];
      const seenSizes = new Set();
      for (const node of document.querySelectorAll(sizeSelector)) {
        const raw = cleanText(node.getAttribute?.("data-size") || node.getAttribute?.("value") || node.getAttribute?.("aria-label") || node.textContent || "");
        const match = raw.match(/(?:^|\b)(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|ONE\s*SIZE|OS|(?:IT|EU|FR|UK|US)?\s*\d{1,3}(?:[.,]5)?)(?:\b|$)/i);
        const size = cleanText(match?.[1] || "").toUpperCase();
        if (!size || seenSizes.has(size)) continue;
        seenSizes.add(size);
        const state = cleanText([raw, node.getAttribute?.("aria-disabled"), node.getAttribute?.("title"), node.className, node.parentElement?.className].filter(Boolean).join(" "));
        const disabled = Boolean(node.hasAttribute?.("disabled") || node.getAttribute?.("aria-disabled") === "true" || /disabled|unavailable|sold.?out|out.?of.?stock/i.test(state));
        sizes.push({ size, text: size, disabled, available: !disabled, status: disabled ? "SOLD_OUT" : "IN_STOCK" });
      }

      const description = cleanText(productLd.description || document.querySelector('.product-selection__description')?.textContent || document.querySelector('[class*="product-details" i]')?.textContent || "");
      const media = [];
      const seenMedia = new Set();
      const compactCode = productCode.replace(/[^a-z0-9]/gi, "");
      const addMedia = (value, alt = "") => {
        const url = absolute(value);
        if (!url || seenMedia.has(url)) return;
        let parsed; try { parsed = new URL(url); } catch { return; }
        const compactPath = decodeURIComponent(parsed.pathname).replace(/[^a-z0-9]/gi, "").toUpperCase();
        if (!/(^|\.)thron\.com$/i.test(parsed.hostname) || !parsed.pathname.toLowerCase().includes('/delivery/public/image/stoneisland/')) return;
        if (!compactCode || !compactPath.includes(compactCode)) return;
        if (/logo|icon|sprite|flag|payment/i.test(url)) return;
        seenMedia.add(url);
        media.push({ type: "image", url, originalUrl: url, alt: cleanText(alt), byteLength: 100000 });
      };
      for (const image of document.querySelectorAll('.product-hero img, .product-gallery img, [class*="product-gallery" i] img, [class*="product-hero" i] img')) {
        const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
        const largest = srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).at(-1);
        addMedia(image.currentSrc || largest || image.src || image.getAttribute("data-src"), image.alt || title);
      }
      for (const image of Array.isArray(productLd.image) ? productLd.image : [productLd.image]) addMedia(typeof image === "string" ? image : image?.url, title);

      const soldOutText = cleanText(document.querySelector('[data-testid*="sold-out" i], .product-selection__sold-out, [class*="sold-out" i]')?.textContent || "");
      return {
        url: location.href,
        title,
        brand: "Stone Island",
        description,
        descriptionHtml: description ? `<p>${description.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>` : "",
        bodyText,
        pageHtml,
        color,
        productCode,
        currency,
        price,
        compareAtPrice,
        productAvailable: !/sold out|out of stock|currently unavailable/i.test(soldOutText),
        sizes,
        media: media.slice(0, 8),
      };
    },
  });
  const page = injected?.[0]?.result;
  if (!page?.productCode) throw new Error("Stone Island product code was not found.");
  if (!page?.title) throw new Error("Stone Island product title was not found.");
  if (!page?.color) throw new Error("Stone Island selected color was not found.");
  if (!page?.price) throw new Error("Stone Island current price was not found.");
  if (!page?.media?.length) throw new Error("Stone Island exact product images were not found.");
  return page;
}

async function captureProduct(url, s, context) {
  const tab = await chrome.tabs.create({ url, active: true });
  try {
    await waitForTab(tab.id);
    await sleep(Number(s.loadWaitMs || DEFAULTS.loadWaitMs));
    const page = await readStoneProduct(tab.id);
    const { capture } = endpoints(s);
    const payload = {
      shop: clean(s.shop).toLowerCase(), token: s.token, agentId: "stone-island-chrome", version: VERSION,
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
    return jsonRequest(capture, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ParserVo-Token": s.token },
      body: JSON.stringify(payload),
    }, 150000);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function jobActive(s, jobId) {
  const data = await queueRequest(s, { action: "job-status", jobId }, 20000);
  return !data.cancelled && !data.terminal;
}

async function processJob(s, job) {
  const configs = Array.isArray(job.configs) ? job.configs : [];
  const limit = Math.max(0, Number(job.max_products || 0));
  const found = [];
  let pagesDone = 0;
  for (const config of configs) {
    for (const pageUrl of Array.isArray(config.pageUrls) ? config.pageUrls : []) {
      if (stopRequested || !(await jobActive(s, job.id))) return;
      const remaining = limit > 0 ? Math.max(0, limit - found.length) : 0;
      const links = await collectProductLinks(pageUrl, remaining, Number(s.loadWaitMs || DEFAULTS.loadWaitMs));
      for (const link of links) {
        if (!found.some((row) => row.url === link)) found.push({ url: link, config });
        if (limit > 0 && found.length >= limit) break;
      }
      pagesDone += 1;
      await queueRequest(s, { action: "progress", jobId: job.id, pagesTotal: configs.length, pagesDone, linksFound: found.length, productsTotal: limit || found.length, productsDone: stats.captured, productsFailed: stats.failed, message: `Found ${found.length} Stone Island product links` });
      if (limit > 0 && found.length >= limit) break;
    }
  }
  const selected = limit > 0 ? found.slice(0, limit) : found;
  stats.total = selected.length;
  if (!selected.length) throw new Error("No strict Stone Island product links were found on this catalog page.");

  for (const row of selected) {
    if (stopRequested || !(await jobActive(s, job.id))) return;
    setCurrent(`Capturing ${row.url}`);
    try {
      await captureProduct(row.url, s, {
        jobId: job.id,
        categoryId: row.config.id,
        gender: row.config.gender,
        category: row.config.category,
        plnRate: row.config.plnRate,
        eurRate: row.config.eurRate,
        defaultQuantity: row.config.defaultQuantity,
      });
      stats.captured += 1;
      log(`Imported ${row.url}`);
    } catch (error) {
      stats.failed += 1;
      log(`${row.url}\n${messageOf(error)}`, true);
    } finally {
      stats.processed += 1;
      await queueRequest(s, { action: "progress", jobId: job.id, pagesTotal: configs.length, pagesDone, linksFound: found.length, productsTotal: selected.length, productsDone: stats.captured, productsFailed: stats.failed, message: `Imported ${stats.captured}/${selected.length}; errors ${stats.failed}`, result: { errors: logs.filter((line) => line.includes("ERROR")).slice(0, 20) } }).catch(() => {});
    }
  }

  if (!stopRequested) {
    await queueRequest(s, { action: "complete", jobId: job.id, pagesTotal: configs.length, pagesDone, linksFound: found.length, productsTotal: selected.length, productsDone: stats.captured, productsFailed: stats.failed, message: `Completed ${stats.captured}/${selected.length}; errors ${stats.failed}`, result: { version: VERSION } });
  }
}

async function runQueue() {
  if (running) return;
  running = true;
  stopRequested = false;
  stats = { processed: 0, captured: 0, failed: 0, total: 0 };
  try {
    const s = validate(await settings());
    await heartbeat("ONLINE", "Checking Stone Island queue");
    const claimed = await queueRequest(s, { action: "claim" });
    if (!claimed.job) { setCurrent("Waiting for ParserVo jobs"); return; }
    setCurrent(`Job ${claimed.job.id}`);
    await heartbeat("BUSY", "Stone Island job running", claimed.job.id);
    try {
      await processJob(s, claimed.job);
    } catch (error) {
      log(messageOf(error), true);
      await queueRequest(s, { action: "error", jobId: claimed.job.id, productsTotal: stats.total, productsDone: stats.captured, productsFailed: stats.failed + 1, message: messageOf(error), result: { version: VERSION, logs: logs.slice(0, 20) } }).catch(() => {});
    }
  } catch (error) {
    log(messageOf(error), true);
  } finally {
    running = false;
    setCurrent(stopRequested ? "Stopped" : "Waiting for ParserVo jobs");
    heartbeat("ONLINE", current).catch(() => {});
  }
}

async function captureCurrentTab() {
  const s = validate(await settings());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !strictStoneProductUrl(tab.url, tab.url)) throw new Error("Open a Stone Island product page first.");
  const page = await readStoneProduct(tab.id);
  const { capture } = endpoints(s);
  return jsonRequest(capture, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-ParserVo-Token": s.token },
    body: JSON.stringify({
      shop: clean(s.shop).toLowerCase(), token: s.token, agentId: "stone-island-chrome", version: VERSION,
      capture: { categoryId: "stone-island:manual", source: "STONE_ISLAND", gender: /\/women\//i.test(page.url) ? "WOMEN" : "MEN", category: "Catalog", ...page, defaultQuantity: 5, rates: { pln: s.plnRate, eur: s.eurRate } },
    }),
  }, 150000);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  heartbeat().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  heartbeat().catch(() => {});
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const s = await settings();
  if (s.autoQueue !== false) runQueue(); else heartbeat().catch(() => {});
});
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    if (request?.action === "state") return { ok: true, version: VERSION, running, current, logs, stats, settings: await settings() };
    if (request?.action === "save") { await chrome.storage.local.set(request.settings || {}); return { ok: true }; }
    if (request?.action === "test") { await heartbeat("ONLINE", "API connection successful"); return { ok: true }; }
    if (request?.action === "start") { runQueue(); return { ok: true }; }
    if (request?.action === "stop") { stopRequested = true; return { ok: true }; }
    if (request?.action === "capture-current") return await captureCurrentTab();
    if (request?.action === "clear-log") { logs = []; return { ok: true }; }
    return { ok: false, error: "Unknown action" };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: messageOf(error) }));
  return true;
});
