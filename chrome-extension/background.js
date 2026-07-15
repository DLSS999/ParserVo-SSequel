const SETTINGS_FIELDS = [
  "apiBaseUrl",
  "shop",
  "token",
  "plnRate",
  "eurRate",
  "batchSize",
  "maxQueuedToLoad",
  "openDelayMs",
  "loadWaitMs",
  "captureDelayMs",
];

const DEFAULTS = {
  plnRate: "12.19",
  eurRate: "45",
  batchSize: "20",
  maxQueuedToLoad: "1000",
  openDelayMs: "1000",
  loadWaitMs: "8000",
  captureDelayMs: "900",
};

const runtimeState = {
  running: false,
  stopRequested: false,
  current: "Idle",
  lastError: "",
  logs: [],
  stats: {
    queuedTotal: 0,
    batchesTotal: 0,
    currentBatch: 0,
    processed: 0,
    created: 0,
    duplicates: 0,
    updated: 0,
    failed: 0,
  },
  startedAt: null,
  finishedAt: null,
};

function snapshotState() {
  return JSON.parse(JSON.stringify(runtimeState));
}

function persistState() {
  chrome.storage.local.set({ parservoRuntimeState: snapshotState() }).catch(() => {});
}

function setCurrent(message) {
  runtimeState.current = message;
  runtimeState.lastError = "";
  persistState();
}

function addLog(message, isError = false) {
  const time = new Date().toLocaleTimeString();
  const prefix = isError ? "ERROR" : "INFO";
  runtimeState.logs.unshift(`[${time}] ${prefix}: ${message}`);
  runtimeState.logs = runtimeState.logs.slice(0, 350);
  runtimeState.current = message;
  runtimeState.lastError = isError ? message : "";
  persistState();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInt(value, fallback, min = 1, max = 100000) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBaseUrl(value) {
  let url = String(value || "").trim();

  if (!url) return "";

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  return url.replace(/\/+$/, "");
}

function buildEndpoint(apiBaseUrl, path) {
  let normalized = normalizeBaseUrl(apiBaseUrl);

  if (!normalized) return "";

  normalized = normalized.replace(/\/api\/(vitkac-capture|import-queue)$/i, "");

  return `${normalized}${path}`;
}

function buildCaptureEndpoint(apiBaseUrl) {
  return buildEndpoint(apiBaseUrl, "/api/vitkac-capture");
}

function buildQueueEndpoint(apiBaseUrl) {
  return buildEndpoint(apiBaseUrl, "/api/import-queue");
}

function buildStockRefreshQueueEndpoint(apiBaseUrl) {
  return buildEndpoint(apiBaseUrl, "/api/stock-refresh-queue");
}

function normalizeShop(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRateString(value, fallback) {
  const raw = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.\-]/g, "");

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return String(fallback);
  }

  // В API отправляем строку, а не Number().
  // Иначе значение вида 12,50 превращалось в NaN -> JSON null,
  // и приложение брало старый курс из базы.
  return raw;
}

function validateSettings(settings) {
  const captureEndpoint = buildCaptureEndpoint(settings.apiBaseUrl);
  const queueEndpoint = buildQueueEndpoint(settings.apiBaseUrl);
  const stockRefreshQueueEndpoint = buildStockRefreshQueueEndpoint(settings.apiBaseUrl);
  const shop = normalizeShop(settings.shop);
  const token = String(settings.token || "").trim();

  if (!captureEndpoint || !queueEndpoint || !stockRefreshQueueEndpoint) {
    throw new Error("Set Local API Base URL, for example http://localhost:51220 or https://xxxx.trycloudflare.com");
  }

  if (!shop) {
    throw new Error("Set shop, for example parservo.myshopify.com");
  }

  if (!token) {
    throw new Error("Set browser capture token from the app.");
  }

  return { captureEndpoint, queueEndpoint, stockRefreshQueueEndpoint, shop, token };
}

function explainFetchError(endpoint, error) {
  const message = error instanceof Error ? error.message : String(error);

  return [
    `Failed to fetch API endpoint: ${endpoint}`,
    `Browser error: ${message}`,
    "",
    "Проверь:",
    "1. Приложение запущено через shopify app dev.",
    "2. В Local API Base URL вставлен именно Local/Preview URL из PowerShell, без admin.shopify.com.",
    "3. После замены manifest.json расширение было Reload в chrome://extensions/.",
    "4. Если используешь localhost, попробуй http://127.0.0.1:PORT вместо http://localhost:PORT.",
  ].join("\n");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonResponse(response, endpoint) {
  const text = await response.text();

  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error(`API returned non-JSON response (${response.status}) from ${endpoint}:\n${text.slice(0, 700)}`);
  }
}

async function getSettings() {
  const saved = await chrome.storage.local.get(SETTINGS_FIELDS);
  return { ...DEFAULTS, ...saved };
}

async function waitForTabLoaded(tabId, timeoutMs = 45000) {
  const startedAt = Date.now();
  let lastTab = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastTab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(`Tab was closed before capture: ${error instanceof Error ? error.message : String(error)}`);
    }

    const tabUrl = lastTab?.url || "";

    if (tabUrl.startsWith("chrome-error://")) {
      throw new Error(`Chrome could not load the page: ${tabUrl}`);
    }

    if (lastTab.status === "complete") {
      return lastTab;
    }

    await sleep(800);
  }

  return lastTab || chrome.tabs.get(tabId);
}

async function readPageDirectlyFromTab(tabId) {
  let injected;

  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const html = document.documentElement ? document.documentElement.outerHTML : "";
        const text = document.body ? document.body.innerText : "";

        return {
          ok: true,
          url: window.location.href,
          title: document.title || "",
          html,
          htmlLength: html.length,
          textLength: text.length,
          readyState: document.readyState,
        };
      },
    });
  } catch (error) {
    throw new Error(
      [
        "Could not read HTML directly from the Vitkac tab.",
        error instanceof Error ? error.message : String(error),
        "",
        "Что сделать:",
        "1. Открой chrome://extensions/ и нажми Reload / Обновить на ParserVo.",
        "2. Убедись, что открыт именно товар Vitkac, а не пустая/ошибочная вкладка.",
        "3. Если Chrome спросит доступ расширения к сайту Vitkac — разреши.",
      ].join("\n"),
    );
  }

  const result = injected?.[0]?.result;

  if (!result || !result.ok) {
    throw new Error("Chrome returned empty result while reading the Vitkac tab.");
  }

  return result;
}

async function getVitkacPageFromTab(tab) {
  if (!tab?.id) throw new Error("No tab id.");

  const loadedTab = await waitForTabLoaded(tab.id);
  const tabUrl = loadedTab?.url || tab.url || "";

  if (!tabUrl.includes("vitkac.com") || !tabUrl.includes("/p/")) {
    throw new Error(`Tab is not a Vitkac product page: ${tabUrl || "empty url"}`);
  }

  let lastError = "";

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const page = await readPageDirectlyFromTab(tab.id);

    if (!page.url.includes("vitkac.com") || !page.url.includes("/p/")) {
      throw new Error(`Captured tab is not a Vitkac product page: ${page.url || "empty url"}`);
    }

    if (page.html && page.html.length >= 1000) {
      return page;
    }

    lastError = `Vitkac HTML is too short (${page.htmlLength || 0} chars). Attempt ${attempt}/10. Waiting for the page to finish rendering...`;
    addLog(lastError, true);
    await sleep(1500);
  }

  throw new Error(lastError || "Could not capture Vitkac HTML from the tab.");
}

async function postCapture(page, settings) {
  const { captureEndpoint, shop, token } = validateSettings(settings);
  let response;

  try {
    response = await fetchWithTimeout(captureEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
        "X-ParserVo-Token": token,
      },
      body: JSON.stringify({
        shop,
        token,
        url: page.url,
        html: page.html,
        rates: {
          pln: normalizeRateString(settings.plnRate, DEFAULTS.plnRate),
          eur: normalizeRateString(settings.eurRate, DEFAULTS.eurRate),
        },
      }),
    });
  } catch (error) {
    throw new Error(explainFetchError(captureEndpoint, error));
  }

  const data = await readJsonResponse(response, captureEndpoint);

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `API error ${response.status}`);
  }

  return data;
}

async function captureTab(tab, settings, options = {}) {
  const closeAfter = Boolean(options.closeAfter);
  let latestTab = tab;

  try {
    latestTab = tab?.id ? await chrome.tabs.get(tab.id) : tab;
    const page = await getVitkacPageFromTab(latestTab);
    addLog(`Captured HTML: ${page.title || page.url}\nHTML length: ${page.htmlLength || page.html?.length || "—"}`);

    const result = await postCapture(page, settings);

    if (result.duplicate && result.stockUpdated) {
      addLog(`STOCK UPDATED: ${result.product?.brand || ""} ${result.product?.title || page.title}\nAvailable: ${(result.product?.availableSizes || []).join(", ") || "none"}\nShopify: ${result.product?.shopifyInventorySync || "skipped"}`);
    } else if (result.duplicate) {
      addLog(`DUPLICATE: ${result.product?.brand || ""} ${result.product?.title || page.title}`);
    } else {
      addLog(`CREATED: ${result.product?.brand || ""} ${result.product?.title || page.title}\nPrice: ${result.product?.salePriceUah || "—"} UAH\nImages: ${result.product?.imagesCount || 0}`);
    }

    return result;
  } finally {
    if (closeAfter && latestTab?.id) {
      try {
        await chrome.tabs.remove(latestTab.id);
      } catch {
        // The user may have already closed the tab.
      }
    }
  }
}

async function testApiConnection() {
  const settings = await getSettings();
  const { captureEndpoint, queueEndpoint, stockRefreshQueueEndpoint } = validateSettings(settings);

  for (const endpoint of [captureEndpoint, queueEndpoint, stockRefreshQueueEndpoint]) {
    let response;

    try {
      response = await fetchWithTimeout(endpoint, { method: "GET" }, 25000);
    } catch (error) {
      throw new Error(explainFetchError(endpoint, error));
    }

    const data = await readJsonResponse(response, endpoint);

    if (!response.ok || !data.ok) {
      throw new Error(data.error || `API test failed with HTTP ${response.status} at ${endpoint}`);
    }
  }

  addLog(`API OK:\n${captureEndpoint}\n${queueEndpoint}\n${stockRefreshQueueEndpoint}`);
}

async function fetchQueuedUrls(settings) {
  const { queueEndpoint, shop, token } = validateSettings(settings);
  const limit = toPositiveInt(settings.maxQueuedToLoad, 1000, 1, 5000);
  let response;

  try {
    response = await fetchWithTimeout(queueEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
        "X-ParserVo-Token": token,
      },
      body: JSON.stringify({ shop, token, limit }),
    }, 45000);
  } catch (error) {
    throw new Error(explainFetchError(queueEndpoint, error));
  }

  const data = await readJsonResponse(response, queueEndpoint);

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Import queue API error ${response.status}`);
  }

  const urls = Array.isArray(data.urls) ? data.urls : [];
  return urls
    .map((item) => (typeof item === "string" ? item : item?.supplierUrl || item?.url || ""))
    .filter((url) => url.includes("vitkac.com") && url.includes("/p/"));
}

async function fetchStockRefreshUrls(settings) {
  const { stockRefreshQueueEndpoint, shop, token } = validateSettings(settings);
  const limit = toPositiveInt(settings.maxQueuedToLoad, 1000, 1, 5000);
  let response;

  try {
    response = await fetchWithTimeout(stockRefreshQueueEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
        "X-ParserVo-Token": token,
      },
      body: JSON.stringify({ shop, token, limit }),
    }, 45000);
  } catch (error) {
    throw new Error(explainFetchError(stockRefreshQueueEndpoint, error));
  }

  const data = await readJsonResponse(response, stockRefreshQueueEndpoint);

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Stock refresh queue API error ${response.status}`);
  }

  const urls = Array.isArray(data.urls) ? data.urls : [];
  return urls
    .map((item) => (typeof item === "string" ? item : item?.supplierUrl || item?.url || ""))
    .filter((url) => url.includes("vitkac.com") && url.includes("/p/"));
}

async function openBatchTabs(urls, settings) {
  const openDelayMs = toPositiveInt(settings.openDelayMs, 1000, 100, 60000);
  const createdTabs = [];

  for (const url of urls) {
    if (runtimeState.stopRequested) break;

    const tab = await chrome.tabs.create({ url, active: false });
    createdTabs.push(tab);
    addLog(`Opened: ${url}`);
    await sleep(openDelayMs);
  }

  return createdTabs;
}

async function closeTabsQuietly(tabs) {
  for (const tab of tabs) {
    if (!tab?.id) continue;

    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Ignore already closed tabs.
    }
  }
}

async function runAutoBatchImport(mode = "import") {
  if (runtimeState.running) {
    addLog("Automatic import is already running.", true);
    return;
  }

  runtimeState.running = true;
  runtimeState.stopRequested = false;
  runtimeState.lastError = "";
  runtimeState.startedAt = new Date().toISOString();
  runtimeState.finishedAt = null;
  runtimeState.stats = {
    queuedTotal: 0,
    batchesTotal: 0,
    currentBatch: 0,
    processed: 0,
    created: 0,
    duplicates: 0,
    updated: 0,
    failed: 0,
  };
  persistState();

  try {
    const settings = await getSettings();
    validateSettings(settings);

    const batchSize = toPositiveInt(settings.batchSize, 20, 1, 50);
    const loadWaitMs = toPositiveInt(settings.loadWaitMs, 8000, 1000, 120000);
    const captureDelayMs = toPositiveInt(settings.captureDelayMs, 900, 100, 60000);

    const isStockRefresh = mode === "stock_refresh";
    addLog(isStockRefresh ? "Loading imported Vitkac links for stock refresh..." : "Loading queued Vitkac links from Excel import queue...");
    const queuedUrlsRaw = isStockRefresh ? await fetchStockRefreshUrls(settings) : await fetchQueuedUrls(settings);
    const queuedUrls = Array.from(new Set(queuedUrlsRaw));

    runtimeState.stats.queuedTotal = queuedUrls.length;
    runtimeState.stats.batchesTotal = Math.ceil(queuedUrls.length / batchSize);
    persistState();

    if (queuedUrls.length === 0) {
      addLog(isStockRefresh ? "No imported Vitkac links found for stock refresh." : "No queued Vitkac links found. Upload Excel first or check that queue items have status queued.");
      return;
    }

    addLog(`${isStockRefresh ? "Stock refresh" : "Automatic import"} started. Queue: ${queuedUrls.length}. Batch size: ${batchSize}.`);

    for (let start = 0; start < queuedUrls.length; start += batchSize) {
      if (runtimeState.stopRequested) break;

      const batch = queuedUrls.slice(start, start + batchSize);
      const batchNumber = Math.floor(start / batchSize) + 1;
      runtimeState.stats.currentBatch = batchNumber;
      persistState();

      addLog(`Batch ${batchNumber}/${runtimeState.stats.batchesTotal}: opening ${batch.length} tabs...`);
      const tabs = await openBatchTabs(batch, settings);

      if (tabs.length === 0) {
        addLog(`Batch ${batchNumber}: no tabs opened.`, true);
        continue;
      }

      addLog(`Batch ${batchNumber}: waiting ${Math.round(loadWaitMs / 1000)} seconds for Vitkac pages to load...`);
      await sleep(loadWaitMs);

      for (const tab of tabs) {
        if (runtimeState.stopRequested) break;

        try {
          const result = await captureTab(tab, settings, { closeAfter: true });

          if (result.stockUpdated) {
            runtimeState.stats.updated += 1;
          }

          if (result.duplicate) {
            runtimeState.stats.duplicates += 1;
          } else {
            runtimeState.stats.created += 1;
          }
        } catch (error) {
          runtimeState.stats.failed += 1;
          addLog(`FAILED TAB: ${tab?.url || "unknown url"}\n${error instanceof Error ? error.message : String(error)}`, true);

          if (tab?.id) {
            try {
              await chrome.tabs.remove(tab.id);
            } catch {
              // Ignore already closed tabs.
            }
          }
        } finally {
          runtimeState.stats.processed += 1;
          persistState();
          await sleep(captureDelayMs);
        }
      }

      if (runtimeState.stopRequested) {
        await closeTabsQuietly(tabs);
        break;
      }

      addLog(`Batch ${batchNumber} finished. Created: ${runtimeState.stats.created}. Updated: ${runtimeState.stats.updated}. Duplicates: ${runtimeState.stats.duplicates}. Failed: ${runtimeState.stats.failed}.`);
    }

    if (runtimeState.stopRequested) {
      addLog(`${isStockRefresh ? "Stock refresh" : "Automatic import"} stopped by user. Processed: ${runtimeState.stats.processed}/${runtimeState.stats.queuedTotal}.`);
    } else {
      addLog(`${isStockRefresh ? "Stock refresh" : "Automatic import"} finished. Created: ${runtimeState.stats.created}. Updated: ${runtimeState.stats.updated}. Duplicates: ${runtimeState.stats.duplicates}. Failed: ${runtimeState.stats.failed}.`);
    }
  } catch (error) {
    addLog(error instanceof Error ? error.message : String(error), true);
  } finally {
    runtimeState.running = false;
    runtimeState.stopRequested = false;
    runtimeState.finishedAt = new Date().toISOString();
    persistState();
  }
}

async function captureCurrentTab() {
  const settings = await getSettings();
  validateSettings(settings);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await captureTab(tab, settings, { closeAfter: false });
}

async function captureAllOpenTabs() {
  const settings = await getSettings();
  validateSettings(settings);
  const tabs = await chrome.tabs.query({});
  const vitkacTabs = tabs.filter((tab) => tab.url && tab.url.includes("vitkac.com") && tab.url.includes("/p/"));

  if (vitkacTabs.length === 0) {
    throw new Error("No open Vitkac product tabs found.");
  }

  addLog(`Found ${vitkacTabs.length} open Vitkac product tabs. Capturing one by one...`);

  let success = 0;
  let failed = 0;

  for (const tab of vitkacTabs) {
    try {
      await captureTab(tab, settings, { closeAfter: false });
      success += 1;
    } catch (error) {
      failed += 1;
      addLog(`FAILED TAB: ${tab.url}\n${error instanceof Error ? error.message : String(error)}`, true);
    }

    await sleep(600);
  }

  addLog(`Manual capture finished. Success: ${success}. Failed: ${failed}.`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = async () => {
    const type = message?.type;

    if (type === "GET_STATE") {
      return { ok: true, state: snapshotState() };
    }

    if (type === "CLEAR_LOG") {
      runtimeState.logs = [];
      runtimeState.lastError = "";
      runtimeState.current = runtimeState.running ? "Running" : "Idle";
      persistState();
      return { ok: true, state: snapshotState() };
    }

    if (type === "STOP_AUTO") {
      runtimeState.stopRequested = true;
      addLog("Stop requested. Current tabs will be closed after the current operation.");
      return { ok: true, state: snapshotState() };
    }

    if (type === "START_STOCK_REFRESH") {
      if (runtimeState.running) {
        return { ok: false, error: "Automatic process is already running.", state: snapshotState() };
      }

      runAutoBatchImport("stock_refresh").catch((error) => {
        addLog(error instanceof Error ? error.message : String(error), true);
      });

      return { ok: true, state: snapshotState() };
    }

    if (type === "START_AUTO") {
      if (runtimeState.running) {
        return { ok: false, error: "Automatic import is already running.", state: snapshotState() };
      }

      runAutoBatchImport().catch((error) => {
        addLog(error instanceof Error ? error.message : String(error), true);
      });

      return { ok: true, state: snapshotState() };
    }

    if (type === "TEST_API") {
      await testApiConnection();
      return { ok: true, state: snapshotState() };
    }

    if (type === "CAPTURE_CURRENT") {
      await captureCurrentTab();
      return { ok: true, state: snapshotState() };
    }

    if (type === "CAPTURE_ALL_OPEN") {
      await captureAllOpenTabs();
      return { ok: true, state: snapshotState() };
    }

    return { ok: false, error: `Unknown message type: ${type}` };
  };

  respond()
    .then((result) => sendResponse(result))
    .catch((error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      addLog(messageText, true);
      sendResponse({ ok: false, error: messageText, state: snapshotState() });
    });

  return true;
});
