// ParserVo Stone Island Capture 2.9.3
// LOAD MORE operates on base product cards, while job.max_products refers to
// final colour variants. Never derive required catalog clicks from the colour
// variant limit. Finish the base catalog only after the button is gone and the
// link count remains stable through repeated checks.

collectProductLinks = async function collectStoneIslandBaseLinksV293(
  catalogUrl,
  limit,
  loadWaitMs,
  itemsPerLoad = 16,
) {
  const requestedFinalVariants = Math.max(0, Math.trunc(Number(limit || 0)));
  const smallTestLimit = requestedFinalVariants > 0 && requestedFinalVariants <= 50
    ? requestedFinalVariants
    : 0;
  const waitMs = Math.max(3500, Number(loadWaitMs || 4500));
  let tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  const links = new Set();
  let loadMoreClicks = 0;
  let reloads = 0;
  let noButtonStable = 0;
  let noGrowthAfterClick = 0;
  let lastState = null;

  const ensureTab = async () => {
    try {
      await chrome.tabs.get(tab.id);
    } catch {
      tab = await chrome.tabs.create({ url: catalogUrl, active: true });
      reloads += 1;
      await waitForTab(tab.id, 60000);
      await sleep(waitMs);
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
        const absolute = /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi;
        const relative = /["'](\/[a-z]{2}-[a-z]{2}\/collection\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?)["']/gi;
        for (const match of html.matchAll(absolute)) add(match[0]);
        for (const match of html.matchAll(relative)) add(match[1]);

        const bodyText = text(document.body?.innerText || "");
        const totals = [];
        for (const match of bodyText.matchAll(/\b([0-9][0-9\s.,]*)\s+(?:products?|results?|items?)\b/gi)) {
          const value = Number(String(match[1]).replace(/[\s.,]/g, ""));
          if (Number.isFinite(value) && value > 0 && value < 10000) totals.push(value);
        }

        const buttons = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )];
        const loadMore = buttons.find((node) => /^load\s+more(?:\s+products?)?$/i.test(text(
          node.textContent
          || node.getAttribute("value")
          || node.getAttribute("aria-label")
          || node.getAttribute("title")
          || "",
        ))) || null;

        return {
          url: location.href,
          title: document.title || "",
          links: [...found],
          totalVariants: totals.length ? Math.max(...totals) : 0,
          hasLoadMore: Boolean(loadMore),
          disabled: Boolean(
            loadMore?.disabled
            || loadMore?.getAttribute("aria-disabled") === "true"
            || loadMore?.getAttribute("data-disabled") === "true"
          ),
          bodyHeight: document.body?.scrollHeight || 0,
        };
      },
    });

    const state = injected?.[0]?.result;
    if (!state) throw new Error("Stone Island catalog snapshot returned no data.");
    lastState = state;
    for (const value of state.links || []) {
      const normalized = strictStoneProductUrl(value, catalogUrl);
      if (normalized) links.add(normalized);
    }
    if (Number(state.totalVariants) > catalogVariantTotal) {
      catalogVariantTotal = Number(state.totalVariants);
    }
    return state;
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
          node.textContent
          || node.getAttribute("value")
          || node.getAttribute("aria-label")
          || node.getAttribute("title")
          || "",
        )));

        if (!button) return { clicked: false, reason: "missing" };
        if (
          button.disabled
          || button.getAttribute("aria-disabled") === "true"
          || button.getAttribute("data-disabled") === "true"
        ) {
          return { clicked: false, reason: "disabled" };
        }

        button.scrollIntoView({ block: "center", behavior: "auto" });
        try { button.focus({ preventScroll: true }); } catch {}
        try {
          button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
          button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
          button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        } catch {}
        button.click();
        return { clicked: true, reason: "clicked" };
      },
    });
    return injected?.[0]?.result || { clicked: false, reason: "no-result" };
  };

  try {
    await waitForTab(tab.id, 60000);
    await sleep(waitMs);

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
      await sleep(Math.max(5000, waitMs));
      initialDeadline = Date.now() + 60000;
      while (Date.now() < initialDeadline && links.size === 0) {
        await snapshot();
        if (links.size > 0) break;
        await sleep(1000);
      }
    }

    if (links.size === 0) {
      throw new Error(
        `No strict Stone Island product links were found. URL: ${lastState?.url || catalogUrl}; `
        + `title: ${lastState?.title || "unknown"}.`,
      );
    }

    for (let round = 0; round < 300; round += 1) {
      if (smallTestLimit > 0 && links.size >= smallTestLimit) break;
      if (stopRequested) break;

      const before = links.size;
      const state = await snapshot();
      setCurrent(
        `Loading base products ${links.size}; catalogue colour variants ${catalogVariantTotal || requestedFinalVariants || "?"}`,
      );

      if (!state.hasLoadMore || state.disabled) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.scrollTo(0, Math.max(0, document.body.scrollHeight - 250)),
        }).catch(() => {});
        await sleep(1800);
        const afterState = await snapshot();

        if (links.size > before || afterState.hasLoadMore) {
          noButtonStable = 0;
          continue;
        }

        noButtonStable += 1;
        if (noButtonStable >= 12) break;
        continue;
      }

      noButtonStable = 0;
      const clicked = await clickLoadMore();
      if (!clicked.clicked) {
        await sleep(1400);
        continue;
      }

      const growthDeadline = Date.now() + 45000;
      let grew = false;
      while (Date.now() < growthDeadline) {
        await sleep(750);
        const current = await snapshot();
        if (links.size > before) {
          grew = true;
          loadMoreClicks += 1;
          break;
        }
        if (current.hasLoadMore && !current.disabled && Date.now() + 1500 >= growthDeadline) break;
      }

      if (grew) {
        noGrowthAfterClick = 0;
      } else {
        noGrowthAfterClick += 1;
        if (noGrowthAfterClick >= 6) break;
      }
    }

    log(
      `Catalog ${chrome.runtime.getManifest().version}: ${links.size} base products; `
      + `${catalogVariantTotal || requestedFinalVariants || "?"} final colour variants; `
      + `${loadMoreClicks} successful LOAD MORE clicks; ${reloads} reloads`,
    );

    if (!links.size) {
      throw new Error("Stone Island base catalogue finished with zero product links.");
    }

    return [...links].slice(0, smallTestLimit || undefined);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
};
