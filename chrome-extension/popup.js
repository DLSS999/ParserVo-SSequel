const $ = (id) => document.getElementById(id);

const fields = [
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

const defaults = {
  plnRate: "12.19",
  eurRate: "45",
  batchSize: "20",
  maxQueuedToLoad: "1000",
  openDelayMs: "1000",
  loadWaitMs: "8000",
  captureDelayMs: "900",
};

function localLine(message, isError = false) {
  const time = new Date().toLocaleTimeString();
  const status = $("status");
  status.textContent = `[${time}] ${message}\n\n${status.textContent || ""}`;
  status.className = `status ${isError ? "err" : "ok"}`;
}

async function sendMessage(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });

    if (!response?.ok && response?.error) {
      localLine(response.error, true);
    }

    if (response?.state) {
      renderState(response.state);
    }

    return response;
  } catch (error) {
    localLine(error instanceof Error ? error.message : String(error), true);
    return { ok: false };
  }
}

async function loadSettings() {
  const saved = await chrome.storage.local.get([...fields, "parservoRuntimeState"]);

  for (const field of fields) {
    const value = saved[field] || defaults[field] || "";
    if ($(field)) $(field).value = value;
  }

  if (saved.parservoRuntimeState) {
    renderState(saved.parservoRuntimeState);
  }

  await refreshState();
}

function readSettingsFromForm() {
  const values = {};
  for (const field of fields) values[field] = ($(field)?.value || "").trim();
  return values;
}

async function saveSettings({ silent = false } = {}) {
  const values = readSettingsFromForm();
  await chrome.storage.local.set(values);
  if (!silent) localLine("Settings saved.");
  return values;
}

function renderState(state) {
  if (!state) return;

  const stats = state.stats || {};
  const progress = $("progress");
  const status = $("status");
  const startButton = $("startAuto");
  const stockRefreshButton = $("startStockRefresh");
  const stopButton = $("stopAuto");

  progress.textContent = [
    `Status: ${state.running ? "RUNNING" : "IDLE"}`,
    `Current: ${state.current || "—"}`,
    `Batch: ${stats.currentBatch || 0}/${stats.batchesTotal || 0}`,
    `Processed: ${stats.processed || 0}/${stats.queuedTotal || 0}`,
    `Created: ${stats.created || 0}`,
    `Stock updated: ${stats.updated || 0}`,
    `Duplicates: ${stats.duplicates || 0}`,
    `Failed: ${stats.failed || 0}`,
  ].join("\n");

  const logs = Array.isArray(state.logs) && state.logs.length > 0
    ? state.logs.join("\n\n")
    : "Готово.";

  status.textContent = logs;
  status.className = `status ${state.lastError ? "err" : state.running ? "ok" : ""}`;

  startButton.disabled = Boolean(state.running);
  if (stockRefreshButton) stockRefreshButton.disabled = Boolean(state.running);
  stopButton.disabled = !state.running;
}

async function refreshState() {
  await sendMessage("GET_STATE");
}

async function startAuto() {
  await saveSettings({ silent: true });
  const response = await sendMessage("START_AUTO");

  if (response?.ok) {
    localLine("Automatic import started. You can close this popup; the extension will continue in the background.");
  }
}

async function startStockRefresh() {
  await saveSettings({ silent: true });
  const response = await sendMessage("START_STOCK_REFRESH");

  if (response?.ok) {
    localLine("Stock refresh started. You can close this popup; the extension will continue in the background.");
  }
}

async function stopAuto() {
  await sendMessage("STOP_AUTO");
}

async function testApi() {
  await saveSettings({ silent: true });
  await sendMessage("TEST_API");
}

async function captureCurrent() {
  await saveSettings({ silent: true });
  await sendMessage("CAPTURE_CURRENT");
}

async function captureAll() {
  await saveSettings({ silent: true });
  await sendMessage("CAPTURE_ALL_OPEN");
}

$("saveSettings").addEventListener("click", () => saveSettings());
$("testApi").addEventListener("click", testApi);
$("startAuto").addEventListener("click", startAuto);
$("startStockRefresh").addEventListener("click", startStockRefresh);
$("stopAuto").addEventListener("click", stopAuto);
$("captureCurrent").addEventListener("click", captureCurrent);
$("captureAll").addEventListener("click", captureAll);
$("clearStatus").addEventListener("click", async () => {
  await sendMessage("CLEAR_LOG");
});

loadSettings();
setInterval(refreshState, 1000);
