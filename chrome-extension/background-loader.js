importScripts("background.js");

collectProductLinks = async function collectProductLinksWithReliableLoadMore(catalogUrl, limit, loadWaitMs) {
  const tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  try {
    await waitForTab(tab.id);
    await new Promise((resolve) => setTimeout(resolve, loadWaitMs));

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [catalogUrl, Math.max(0, Number(limit || 0))],
      func: async (baseUrl, requestedLimit) => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();

        const strict = (candidate) => {
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
        };

        const links = new Set();
        const add = (value) => {
          const url = strict(value);
          if (url) links.add(url);
        };

        const collect = () => {
          for (const node of document.querySelectorAll(
            "a[href], [data-url], [data-href], [data-product-url], [data-product-link]",
          )) {
            for (const name of ["href", "data-url", "data-href", "data-product-url", "data-product-link"]) {
              add(node.getAttribute(name));
            }
          }

          const html = (document.documentElement.innerHTML || "")
            .replace(/\\u002[fF]/g, "/")
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&");
          const absolutePattern = /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi;
          for (const match of html.matchAll(absolutePattern)) add(match[0]);

          const relativePattern = /["'](\/[a-z]{2}-[a-z]{2}\/collection\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?)["']/gi;
          for (const match of html.matchAll(relativePattern)) add(match[1]);
        };

        const catalogText = cleanText(document.body?.innerText || "");
        const totalCandidates = [];
        for (const match of catalogText.matchAll(/\b([0-9][0-9\s.,]*)\s+(?:products?|results?)\b/gi)) {
          const value = Number(String(match[1]).replace(/[\s.,]/g, ""));
          if (Number.isFinite(value) && value > 0 && value < 10000) totalCandidates.push(value);
        }
        const pageTotal = totalCandidates.length ? Math.max(...totalCandidates) : 0;
        const targetTotal = requestedLimit > 0
          ? (pageTotal > 0 ? Math.min(requestedLimit, pageTotal) : requestedLimit)
          : pageTotal;

        const isTargetReached = () => targetTotal > 0 && links.size >= targetTotal;
        const isVisible = (node) => {
          if (!node || node.hidden || node.getAttribute("aria-hidden") === "true") return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity || 1) !== 0
            && rect.width > 0
            && rect.height > 0;
        };
        const buttonLabel = (node) => cleanText(
          node?.textContent
          || node?.getAttribute?.("value")
          || node?.getAttribute?.("aria-label")
          || node?.getAttribute?.("title")
          || "",
        );
        const findLoadMore = () => [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => /^(?:load|show|view)\s+more$/i.test(buttonLabel(node)) && isVisible(node)) || null;

        const waitForButton = async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            collect();
            if (isTargetReached()) return null;
            const button = findLoadMore();
            if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
            window.scrollTo(0, document.body.scrollHeight);
            await wait(500);
          }
          return null;
        };

        const fireClick = (button) => {
          try {
            for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
              button.dispatchEvent(new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
              }));
            }
          } catch {
            button.click();
          }
        };

        const waitForGrowth = async (beforeCount, beforeCardCount, timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            await wait(500);
            collect();
            const cardCount = document.querySelectorAll(
              "[data-product-id], [data-product-code], article, li[class*='product' i], div[class*='product-card' i]",
            ).length;
            if (links.size > beforeCount || cardCount > beforeCardCount) {
              await wait(900);
              collect();
              return true;
            }
          }
          return false;
        };

        collect();
        let successfulClicks = 0;
        let stalledAttempts = 0;
        let absentAttempts = 0;

        for (let attempt = 0; attempt < 600; attempt += 1) {
          if (isTargetReached()) break;

          let button = findLoadMore();
          if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
            button = await waitForButton(20000);
          }

          if (!button) {
            absentAttempts += 1;
            collect();
            if (isTargetReached()) break;
            if (absentAttempts >= 8) break;
            window.scrollTo(0, Math.max(0, document.body.scrollHeight - 400));
            await wait(1500);
            window.scrollTo(0, document.body.scrollHeight);
            continue;
          }

          absentAttempts = 0;
          const beforeCount = links.size;
          const beforeCardCount = document.querySelectorAll(
            "[data-product-id], [data-product-code], article, li[class*='product' i], div[class*='product-card' i]",
          ).length;

          button.scrollIntoView({ block: "center", behavior: "auto" });
          await wait(500);
          fireClick(button);

          const grew = await waitForGrowth(beforeCount, beforeCardCount, 30000);
          if (grew || links.size > beforeCount) {
            successfulClicks += 1;
            stalledAttempts = 0;
            continue;
          }

          stalledAttempts += 1;
          if (stalledAttempts >= 8) break;

          // Some Stone Island responses replace the button without changing the
          // page height immediately. Wait for the replacement and retry instead
          // of treating the temporary disappearance as the end of the catalog.
          await waitForButton(12000);
        }

        // Final pass for lazy-rendered links after the last successful request.
        let stablePasses = 0;
        let previousCount = -1;
        for (let pass = 0; pass < 20 && stablePasses < 5; pass += 1) {
          window.scrollTo(0, document.body.scrollHeight);
          await wait(700);
          collect();
          stablePasses = links.size === previousCount ? stablePasses + 1 : 0;
          previousCount = links.size;
          if (isTargetReached()) break;
        }

        return {
          links: [...links],
          pageTotal,
          targetTotal,
          successfulClicks,
          complete: targetTotal <= 0 || links.size >= targetTotal,
        };
      },
    });

    const result = injected?.[0]?.result || {};
    const values = Array.isArray(result.links) ? result.links : [];
    const unique = [...new Set(
      values.map((value) => strictStoneProductUrl(value, catalogUrl)).filter(Boolean),
    )];
    const selected = unique.slice(0, limit > 0 ? limit : undefined);

    log(
      `Catalog loader: found ${unique.length}/${result.targetTotal || result.pageTotal || "?"}; `
      + `LOAD MORE clicks ${result.successfulClicks || 0}`,
    );

    if (result.targetTotal > 0 && unique.length < result.targetTotal) {
      throw new Error(
        `Stone Island catalog is incomplete: found ${unique.length} of ${result.targetTotal} product links. `
        + "The catalog was not imported to avoid a partial result.",
      );
    }

    return selected;
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {}
  }
};
