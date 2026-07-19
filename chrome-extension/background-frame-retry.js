// ParserVo Stone Island Capture 2.10.1
// Stone Island can replace the main frame while hydrating or changing locale.
// Chrome then throws transient errors such as "Frame with ID 0 was removed".
// Wait for a stable tab and retry instead of terminating the whole job.

function parserVoIsFrameLifecycleError(error) {
  const text = messageOf(error);
  return /frame(?:\s+with)?\s+id\s+\d+\s+was\s+removed|frame\s+was\s+removed|no\s+frame\s+with\s+id|execution\s+context\s+was\s+destroyed|cannot\s+find\s+context\s+with\s+specified\s+id|context\s+invalidated|target\s+page.*has\s+been\s+closed|page\s+is\s+in\s+back-forward\s+cache|cannot\s+access\s+contents\s+of\s+url|the\s+tab\s+was\s+closed/i.test(text);
}

async function parserVoWaitForStableStoneTab(tabId, timeoutMs = 60000) {
  const started = Date.now();
  let previousUrl = "";
  let stableTicks = 0;
  let lastStatus = "unknown";

  while (Date.now() - started < timeoutMs) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw error;
    }

    const currentUrl = String(tab.pendingUrl || tab.url || "");
    lastStatus = String(tab.status || "unknown");
    const stoneUrl = /(^|\.)stoneisland\.com\//i.test(currentUrl.replace(/^https?:\/\//i, ""));

    if (tab.status === "complete" && stoneUrl) {
      if (currentUrl === previousUrl) stableTicks += 1;
      else stableTicks = 1;
      previousUrl = currentUrl;
      if (stableTicks >= 4) return tab;
    } else {
      stableTicks = 0;
      previousUrl = currentUrl;
    }

    await sleep(350);
  }

  throw new Error(`Stone Island tab did not become stable. Status: ${lastStatus}.`);
}

const readStoneProductBeforeFrameRetry = readStoneProduct;

readStoneProduct = async function readStoneProductWithFrameRetry(tabId) {
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await parserVoWaitForStableStoneTab(tabId, 70000);
      await sleep(attempt === 1 ? 450 : 900);
      return await readStoneProductBeforeFrameRetry(tabId);
    } catch (error) {
      lastError = error;
      if (!parserVoIsFrameLifecycleError(error) || attempt === 5) throw error;

      const delay = Math.min(8000, 900 * attempt);
      setCurrent(`Stone Island page changed frame; retrying product read ${attempt + 1}/5`);
      log(`Transient frame replacement during product read ${attempt}/5; retrying after ${delay}ms: ${messageOf(error)}`);
      await sleep(delay);
    }
  }

  throw lastError || new Error("Stone Island product frame retry failed.");
};

const collectProductLinksBeforeFrameRetry = collectProductLinks;

collectProductLinks = async function collectProductLinksWithFrameRetry(
  catalogUrl,
  limit,
  loadWaitMs,
  itemsPerLoad = 16,
) {
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await collectProductLinksBeforeFrameRetry(
        catalogUrl,
        limit,
        loadWaitMs,
        itemsPerLoad,
      );
    } catch (error) {
      lastError = error;
      if (!parserVoIsFrameLifecycleError(error) || attempt === 4) throw error;

      const delay = Math.min(12000, 1500 * attempt);
      setCurrent(`Stone Island replaced the catalogue frame; reopening ${attempt + 1}/4`);
      log(`Transient catalogue frame replacement ${attempt}/4; reopening after ${delay}ms: ${messageOf(error)}`);
      await sleep(delay);
    }
  }

  throw lastError || new Error("Stone Island catalogue frame retry failed.");
};
