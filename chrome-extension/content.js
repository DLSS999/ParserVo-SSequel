(() => {
  if (window.__PARSERVO_VITKAC_CAPTURE_INSTALLED__) {
    return;
  }

  window.__PARSERVO_VITKAC_CAPTURE_INSTALLED__ = true;

  function buildResponse() {
    const url = window.location.href;
    const html = document.documentElement ? document.documentElement.outerHTML : "";
    const title = document.title || "";
    const text = document.body ? document.body.innerText : "";

    if (!url.includes("supplier.com")) {
      return { ok: false, error: "This tab is not a Supplier page." };
    }

    if (!/\/p\//.test(url)) {
      return { ok: false, error: "This Supplier tab is not a product page." };
    }

    if (!html || html.length < 1000) {
      return {
        ok: false,
        error: `Supplier HTML is too short (${html.length} chars). Wait until the page is fully loaded and try again.`,
      };
    }

    return {
      ok: true,
      url,
      html,
      title,
      textLength: text.length,
      htmlLength: html.length,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === "PARSERVO_PING") {
      sendResponse({ ok: true, installed: true });
      return true;
    }

    if (message.type !== "PARSERVO_GET_VITKAC_HTML") {
      return false;
    }

    try {
      sendResponse(buildResponse());
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return true;
  });
})();
