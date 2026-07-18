// ParserVo Stone Island Capture 2.9.9
// A product that is explicitly sold out is a normal catalog state, not an import error.

const jsonRequestBeforeOutOfStockClassification = jsonRequest;

function parserVoCleanSizeValue(row) {
  return String(row?.size || row?.text || "").replace(/\s+/g, " ").trim();
}

function parserVoSizeUnavailable(row) {
  const state = `${row?.status || ""} ${row?.text || ""}`;
  const quantity = Number(row?.quantity);
  return Boolean(
    row?.disabled === true
    || row?.available === false
    || (Number.isFinite(quantity) && quantity <= 0)
    || /sold\s*out|out\s*of\s*stock|unavailable|not\s*available|no\s*stock/i.test(state)
  );
}

function parserVoConfirmedOutOfStock(capture) {
  if (!capture || String(capture.source || "").toUpperCase() !== "STONE_ISLAND") return false;
  if (String(capture.mode || "").toUpperCase() === "STOCK_ONLY") return false;
  if (capture.productAvailable === false) return true;

  const sizes = (Array.isArray(capture.sizes) ? capture.sizes : [])
    .filter((row) => parserVoCleanSizeValue(row));
  return sizes.length > 0 && sizes.every(parserVoSizeUnavailable);
}

jsonRequest = async function jsonRequestWithOutOfStockClassification(url, options = {}, timeoutMs) {
  if (/\/api\/ynap-extension-capture(?:\?|$)/i.test(String(url || ""))) {
    try {
      const payload = JSON.parse(String(options?.body || "{}"));
      const capture = payload?.capture;
      if (parserVoConfirmedOutOfStock(capture)) {
        const sizeCount = (Array.isArray(capture?.sizes) ? capture.sizes : []).length;
        log(`Not in stock: ${capture?.url || capture?.title || "Stone Island product"}; sizes checked ${sizeCount}`);
        return {
          ok: true,
          skipped: true,
          reason: "OUT_OF_STOCK",
          product: {
            title: String(capture?.title || "").trim(),
            url: String(capture?.url || "").trim(),
            color: String(capture?.color || "").trim(),
          },
        };
      }
    } catch {
      // Invalid request bodies must continue to the normal transport path.
    }
  }
  return jsonRequestBeforeOutOfStockClassification(url, options, timeoutMs);
};
