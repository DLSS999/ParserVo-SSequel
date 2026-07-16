importScripts("background.js");

collectProductLinks = async function collectProductLinksWithLoadMore(catalogUrl, limit, loadWaitMs) {
  const tab = await chrome.tabs.create({ url: catalogUrl, active: true });
  try {
    await waitForTab(tab.id);
    await new Promise((resolve) => setTimeout(resolve, loadWaitMs));

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [catalogUrl, Math.max(0, Number(limit || 0))],
      func: async (baseUrl, maxLinks) => {
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
          return maxLinks > 0 && links.size >= maxLinks;
        };
        const collect = () => {
          for (const node of document.querySelectorAll("a[href], [data-url], [data-href], [data-product-url]")) {
            for (const name of ["href", "data-url", "data-href", "data-product-url"]) {
              if (add(node.getAttribute(name))) return true;
            }
          }

          const html = (document.documentElement.innerHTML || "")
            .replace(/\\u002[fF]/g, "/")
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&");
          const pattern = /https?:\/\/(?:www\.)?stoneisland\.com\/[^"'<>\s]+?-L[A-Z0-9]{12,}\.html?(?:\?[^"'<>\s]*)?/gi;
          for (const match of html.matchAll(pattern)) {
            if (add(match[0])) return true;
          }
          return maxLinks > 0 && links.size >= maxLinks;
        };

        const findLoadMore = () => [...document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        )].find((node) => {
          const label = cleanText(
            node.textContent ||
            node.getAttribute("value") ||
            node.getAttribute("aria-label") ||
            node.getAttribute("title") ||
            "",
          );
          if (!/^load\s+more$/i.test(label)) return false;
          if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }) || null;

        collect();
        let noGrowthClicks = 0;

        for (let click = 0; click < 250; click += 1) {
          if (maxLinks > 0 && links.size >= maxLinks) break;
          const button = findLoadMore();
          if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") break;

          const beforeCount = links.size;
          const beforeHeight = document.body.scrollHeight;
          button.scrollIntoView({ block: "center", behavior: "auto" });
          await wait(300);
          button.click();

          const deadline = Date.now() + 15000;
          let grew = false;
          while (Date.now() < deadline) {
            await wait(500);
            collect();
            if (links.size > beforeCount || document.body.scrollHeight > beforeHeight) {
              grew = true;
              await wait(500);
              collect();
              break;
            }
            if (!findLoadMore()) break;
          }

          noGrowthClicks = grew || links.size > beforeCount ? 0 : noGrowthClicks + 1;
          if (noGrowthClicks >= 2) break;
        }

        let stable = 0;
        let previousHeight = 0;
        for (let pass = 0; pass < 12 && stable < 3; pass += 1) {
          window.scrollTo(0, document.body.scrollHeight);
          await wait(400);
          collect();
          const height = document.body.scrollHeight;
          stable = height === previousHeight ? stable + 1 : 0;
          previousHeight = height;
          if (maxLinks > 0 && links.size >= maxLinks) break;
        }

        return [...links];
      },
    });

    const values = injected?.[0]?.result || [];
    return [...new Set(
      values.map((value) => strictStoneProductUrl(value, catalogUrl)).filter(Boolean),
    )].slice(0, limit > 0 ? limit : undefined);
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {}
  }
};
