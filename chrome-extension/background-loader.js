importScripts("background.js");

collectProductLinks = async function collectProductLinksWithPersistentCatalogState(catalogUrl, limit, loadWaitMs) {
  let tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  const allLinks = new Set();
  let pageTotal = 0;
  let successfulClicks = 0;
  let reloads = 0;
  let lastSnapshot = null;

  const ensureCatalogTab = async () => {
    try {
      await chrome.tabs.get(tab.id);
      return;
    } catch {
      tab = await chrome.tabs.create({ url: catalogUrl, active: true });
      reloads += 1;
      await waitForTab(tab.id, 60000);
      await sleep(Math.max(5000, Number(loadWaitMs || 4500)));
    }
  };

  const snapshot = async () => {
    await ensureCatalogTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const normalizeProductUrl = (candidate) => {
          try {
            const url = new URL(String(candidate || ""), location.href);
            if (!/(^|\.)stoneisland\.com$/i.test(url.hostname)) return null;
            if (!/\/collection\//i.test(url.pathname)) return null;
            if (!/-L[A-Z0-9]{12,}\.html?$/i.test(url.pathname)) return null;
            url.search = "";
            url.hash = "";
            return url.toString();
          } catch {
            return null;
          }
        };

        const links = new Set();
        const add = (candidate) => {
          const normalized = normalizeProductUrl(candidate);
          if (normalized) links.add(normalized);
        };

        for (const node of document.querySelectorAll(
          "a[href], [data-url], [data-href], [data-product-url], [data-product-link], [data-link]",
        )) {
          for (const name of [
            "href",
            "data-url",
            "data-href",
            "data-product-url",
            "data-product-link",
            "data-link",
          ]) {
            add(node.getAttribute(name));
          }
        }

        const html = (document.documentElement?.innerHTML || "")
          .replace(/\\u002[fF]/g, "/")
          .replace(/\\\//g, "/")
          .replace(/&amp;/g, "&");

        const patterns = [
          /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi,
          /["'](\/[a-z]{2}-[a-z]{2}\/collection\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?)["']/gi,
          /["'](\/collection\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?)["']/gi,
        ];
        for (const pattern of patterns) {
          for (const match of html.matchAll(pattern)) add(match[1] || match[0]);
        }

        const bodyText = cleanText(document.body?.innerText || "");
        const totals = [];
        for (const match of bodyText.matchAll(/\b([0-9][0-9\s.,]*)\s+(?:products?|results?|items?)\b/gi)) {
          const value = Number(String(match[1]).replace(/[\s.,]/g, ""));
          if (Number.isFinite(value) && value > 0 && value < 10000) totals.push(value);
        }

        const buttonCandidates = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )];
        const loadMore = buttonCandidates.find((node) => {
          const label = cleanText(
            node.textContent
            || node.getAttribute("value")
            || node.getAttribute("aria-label")
            || node.getAttribute("title")
            || "",
          );
          return /^load\s+more(?:\s+products?)?$/i.test(label);
        }) || null;

        return {
          url: location.href,
          title: document.title || "",
          bodySnippet: bodyText.slice(0, 500),
          links: [...links],
          pageTotal: totals.length ? Math.max(...totals) : 0,
          hasLoadMore: Boolean(loadMore),
          loadMoreDisabled: Boolean(
            loadMore?.disabled
            || loadMore?.getAttribute("aria-disabled") === "true"
          ),
          cardCount: document.querySelectorAll(
            "[data-product-id], [data-product-code], article, li[class*='product' i], div[class*='product-card' i]",
          ).length,
          readyState: document.readyState,
        };
      },
    });

    const value = injected?.[0]?.result || null;
    if (!value) throw new Error("Stone Island catalog snapshot returned no data.");
    lastSnapshot = value;
    for (const link of value.links || []) {
      const normalized = strictStoneProductUrl(link, catalogUrl);
      if (normalized) allLinks.add(normalized);
    }
    if (Number(value.pageTotal) > pageTotal) pageTotal = Number(value.pageTotal);
    return value;
  };

  const clickLoadMore = async () => {
    await ensureCatalogTab();
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const cleanText = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const button = [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => {
          const label = cleanText(
            node.textContent
            || node.getAttribute("value")
            || node.getAttribute("aria-label")
            || node.getAttribute("title")
            || "",
          );
          return /^load\s+more(?:\s+products?)?$/i.test(label);
        });

        if (!button) return { clicked: false, reason: "missing" };
        if (button.disabled || button.getAttribute("aria-disabled") === "true") {
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

  const target = () => {
    const requested = Math.max(0, Number(limit || 0));
    if (requested > 0 && pageTotal > 0) return Math.min(requested, pageTotal);
    if (requested > 0) return requested;
    return pageTotal;
  };

  const reachedTarget = () => target() > 0 && allLinks.size >= target();

  const waitForInitialCatalog = async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const current = await snapshot();
      if (!/(^|\.)stoneisland\.com$/i.test(new URL(current.url).hostname)) {
        throw new Error(`Stone Island catalog redirected to ${current.url}`);
      }
      if (allLinks.size > 0 || current.hasLoadMore || pageTotal > 0) return true;
      await sleep(1000);
    }
    return false;
  };

  try {
    await waitForTab(tab.id, 60000);
    await sleep(Math.max(3000, Number(loadWaitMs || 4500)));

    let ready = await waitForInitialCatalog();
    if (!ready && reloads < 1) {
      reloads += 1;
      await chrome.tabs.reload(tab.id);
      await waitForTab(tab.id, 60000);
      await sleep(Math.max(5000, Number(loadWaitMs || 4500)));
      ready = await waitForInitialCatalog();
    }

    if (!ready || allLinks.size === 0) {
      throw new Error(
        `Stone Island catalog loaded without product links. URL: ${lastSnapshot?.url || catalogUrl}; `
        + `title: ${lastSnapshot?.title || "unknown"}; page text: ${lastSnapshot?.bodySnippet || "empty"}`,
      );
    }

    let noGrowthRounds = 0;
    let missingButtonRounds = 0;

    for (let round = 0; round < 700 && !reachedTarget(); round += 1) {
      const before = allLinks.size;
      const current = await snapshot();
      setCurrent(`Loading catalog ${allLinks.size}/${target() || pageTotal || "?"}`);

      if (reachedTarget()) break;

      if (!current.hasLoadMore || current.loadMoreDisabled) {
        missingButtonRounds += 1;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.scrollTo(0, Math.max(0, document.body.scrollHeight - 300)),
        }).catch(() => {});
        await sleep(1500);
        await snapshot();
        if (allLinks.size > before) {
          missingButtonRounds = 0;
          noGrowthRounds = 0;
          continue;
        }
        if (missingButtonRounds < 20) continue;
        break;
      }

      missingButtonRounds = 0;
      const clicked = await clickLoadMore();
      if (!clicked.clicked) {
        await sleep(1200);
        continue;
      }

      const growthDeadline = Date.now() + 45000;
      let grew = false;
      while (Date.now() < growthDeadline) {
        await sleep(750);
        await snapshot();
        setCurrent(`Loading catalog ${allLinks.size}/${target() || pageTotal || "?"}`);
        if (allLinks.size > before) {
          grew = true;
          successfulClicks += 1;
          break;
        }
      }

      if (grew) {
        noGrowthRounds = 0;
      } else {
        noGrowthRounds += 1;
        if (noGrowthRounds >= 12) break;
      }
    }

    for (let pass = 0; pass < 20 && !reachedTarget(); pass += 1) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.scrollTo(0, document.body.scrollHeight),
      }).catch(() => {});
      await sleep(800);
      await snapshot();
    }

    const expected = target();
    log(
      `Catalog loader 2.7.0: found ${allLinks.size}/${expected || pageTotal || "?"}; `
      + `LOAD MORE clicks ${successfulClicks}; reloads ${reloads}`,
    );

    if (expected > 0 && allLinks.size < expected) {
      throw new Error(
        `Stone Island catalog is incomplete: found ${allLinks.size} of ${expected} product links. `
        + `Last URL: ${lastSnapshot?.url || catalogUrl}; title: ${lastSnapshot?.title || "unknown"}.`,
      );
    }

    return [...allLinks].slice(0, Number(limit || 0) > 0 ? Number(limit) : undefined);
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
};
