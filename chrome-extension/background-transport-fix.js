// ParserVo Stone Island Capture 2.9.5 transport hardening.
// Product pages can contain several megabytes of HTML. Sending the entire DOM
// causes the browser/Vercel edge to reject some capture requests before they
// reach the application. Keep only the extracted fields and a bounded text
// fallback, then retry genuine transient transport failures.

const jsonRequestBeforeTransportFix = jsonRequest;

function compactCaptureRequest(options) {
  if (!options || typeof options.body !== "string") return options;

  try {
    const payload = JSON.parse(options.body);
    const capture = payload?.capture;
    if (!capture || typeof capture !== "object") return options;

    const compact = {
      ...capture,
      // Direct price, colour, description, sizes and media are already parsed
      // by the extension. Full HTML is unnecessary and can exceed request limits.
      pageHtml: "",
      bodyText: String(capture.bodyText || "").slice(0, 80000),
      description: String(capture.description || "").slice(0, 30000),
      descriptionHtml: String(capture.descriptionHtml || "").slice(0, 40000),
      composition: String(capture.composition || "").slice(0, 10000),
      media: Array.isArray(capture.media) ? capture.media.slice(0, 8) : [],
      sizes: Array.isArray(capture.sizes) ? capture.sizes.slice(0, 120) : [],
      colorVariantUrls: Array.isArray(capture.colorVariantUrls)
        ? capture.colorVariantUrls.slice(0, 80)
        : [],
    };

    const body = JSON.stringify({ ...payload, capture: compact });
    return { ...options, body };
  } catch {
    return options;
  }
}

function retryableTransportError(error) {
  const message = messageOf(error);
  return /failed to fetch|networkerror|network request failed|load failed|abort(?:ed|error)?|timeout|timed out|http\s*(408|425|429|500|502|503|504|520|521|522|523|524)|invalid json/i.test(message);
}

jsonRequest = async function jsonRequestWithTransportRetry(url, options, timeoutMs = 120000) {
  const isCapture = /\/api\/ynap-extension-capture(?:\?|$)/i.test(String(url || ""));
  const requestOptions = isCapture ? compactCaptureRequest(options) : options;
  const delays = isCapture ? [0, 2500, 6000, 12000, 22000] : [0, 1500, 4000];
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (attempt > 0) {
      const delay = delays[attempt];
      setCurrent(`Retrying ${isCapture ? "product import" : "ParserVo request"} ${attempt + 1}/${delays.length}`);
      log(`Transport retry ${attempt + 1}/${delays.length} after ${delay}ms: ${url}`);
      await sleep(delay);
    }

    try {
      return await jsonRequestBeforeTransportFix(
        url,
        requestOptions,
        Math.max(Number(timeoutMs || 0), isCapture ? 210000 : 90000),
      );
    } catch (error) {
      lastError = error;
      if (!retryableTransportError(error) || attempt === delays.length - 1) throw error;
    }
  }

  throw lastError || new Error("ParserVo transport request failed.");
};

// Re-open and re-read a product page when Stone Island temporarily renders an
// incomplete colour/size state. Network retries above do not require reopening
// the page, but incomplete PDP data does.
const captureProductBeforeTransportFix = captureProduct;

captureProduct = async function captureProductWithPageRetry(url, settingsValue, context) {
  let lastResult = null;
  const pageRetryPattern = /selected color was not found|sizes were not captured|product code was not found|current price was not found|exact product images were not found|page load timed out/i;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await captureProductBeforeTransportFix(url, settingsValue, context);
      lastResult = result;
      if (!result || result.ok !== false) {
        await sleep(900);
        return result;
      }
      if (!pageRetryPattern.test(String(result.error || "")) || attempt === 3) return result;
      log(`Product page retry ${attempt + 1}/3: ${url} — ${result.error}`);
    } catch (error) {
      lastResult = { ok: false, page: null, apiResult: null, error: messageOf(error) };
      if (!pageRetryPattern.test(messageOf(error)) || attempt === 3) throw error;
      log(`Product page retry ${attempt + 1}/3: ${url} — ${messageOf(error)}`);
    }

    await sleep(attempt * 3500);
  }

  return lastResult;
};
