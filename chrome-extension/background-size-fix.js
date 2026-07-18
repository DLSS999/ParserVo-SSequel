// ParserVo Stone Island Capture 2.9.7: reliable Stone Island size dropdown capture.
// Preserves sizes already captured by the base reader and adds DOM/JSON fallbacks.

const readStoneProductBeforeSizeFix = readStoneProduct;

readStoneProduct = async function readStoneProductWithReliableSizes(tabId) {
  const page = await readStoneProductBeforeSizeFix(tabId);
  const validExisting = (Array.isArray(page?.sizes) ? page.sizes : []).filter((row) => {
    const value = String(row?.size || row?.text || "").trim();
    return Boolean(value) && !/select\s+size|find\s+my\s+size|size\s+guide/i.test(value);
  });

  if (validExisting.length) {
    page.sizes = validExisting;
    log(`Size capture ${chrome.runtime.getManifest().version}: preserved ${validExisting.length} sizes from base reader`);
    return page;
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const normalizeSize = (value) => {
        const raw = clean(value)
          .replace(/^size\s*:?\s*/i, "")
          .replace(/\s*[-–—:]\s*(?:sold\s*out|out\s*of\s*stock|unavailable|not\s*available|low\s*stock|only\s*\d+\s*left).*$/i, "");
        if (!raw || /select\s+size|find\s+my\s+size|size\s+guide/i.test(raw)) return "";
        const match = raw.match(/(?:^|\b)(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|ONE\s*SIZE|OS|UN|(?:IT|EU|FR|UK|US)?\s*\d{1,3}(?:[.,]5)?)(?:\b|$)/i);
        return clean(match?.[1] || "").toUpperCase().replace(/\s+/g, "").replace(",", ".");
      };

      const findButton = () => document.querySelector(
        '#sizes-combobox, #PDP-size-selector button[aria-haspopup="listbox"], [aria-controls="PDP-size-selector-options"], .selector-size-dropdown__button',
      );

      let sizeButton = findButton();
      const buttonDeadline = Date.now() + 30000;
      while (!sizeButton && Date.now() < buttonDeadline) {
        await wait(300);
        sizeButton = findButton();
      }

      const clickOnce = async () => {
        if (!sizeButton) return false;
        try { sizeButton.scrollIntoView({ block: "center", behavior: "auto" }); } catch {}
        await wait(250);
        if (sizeButton.getAttribute("aria-expanded") === "true") return true;
        try { HTMLElement.prototype.click.call(sizeButton); } catch { try { sizeButton.click(); } catch {} }
        await wait(800);
        if (sizeButton.getAttribute("aria-expanded") === "true") return true;
        try {
          sizeButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
          sizeButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          sizeButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" }));
          sizeButton.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          sizeButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        } catch {}
        await wait(900);
        return sizeButton.getAttribute("aria-expanded") === "true";
      };

      if (sizeButton) await clickOnce();

      const controlledId = sizeButton?.getAttribute("aria-controls") || "PDP-size-selector-options";
      const rootSelector = [
        `#${CSS.escape(controlledId)}`,
        '#PDP-size-selector-options',
        '[role="listbox"]',
        '[role="dialog"][aria-modal="true"]',
        '[aria-modal="true"]',
        '.selector-size-dropdown__options',
        '.selector-size-dropdown__modal',
        '.modal[aria-hidden="false"]',
        '[class*="size-selector" i][class*="modal" i]',
      ].join(', ');
      const candidateSelector = [
        '[role="option"]',
        'input[type="radio"]',
        'input[type="checkbox"]',
        'button',
        'label',
        'option',
        'li',
        '[data-size]',
        '[data-value]',
        '[data-attr-value]',
      ].join(', ');

      const visible = (node) => {
        if (!node || !(node instanceof Element)) return false;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0 || node.closest?.('[role="listbox"], [role="dialog"], #PDP-size-selector-options');
      };

      const rootsNow = () => [...document.querySelectorAll(rootSelector)];
      const optionsReady = () => rootsNow().some((root) => root.querySelectorAll(candidateSelector).length > 0);
      const optionsDeadline = Date.now() + 25000;
      let retriedClick = false;
      while (Date.now() < optionsDeadline && !optionsReady()) {
        if (!retriedClick && Date.now() + 18000 < optionsDeadline && sizeButton) {
          retriedClick = true;
          await clickOnce();
        }
        await wait(300);
      }

      const bySize = new Map();
      const unavailablePattern = /disabled|unavailable|not\s*available|sold.?out|out.?of.?stock|coming\s*soon|no\s*stock/i;
      const availablePattern = /in.?stock|available|selectable/i;

      const addCandidate = (node, rawValue, contextText = "") => {
        const size = normalizeSize(rawValue);
        if (!size) return;
        const related = [node, node?.parentElement, node?.closest?.('li, label, [role="option"], [data-size], [data-value]')].filter(Boolean);
        const stateText = clean(`${contextText} ${related.flatMap((element) => [
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('title'),
          element.getAttribute?.('data-status'),
          element.getAttribute?.('data-stock-status'),
          element.getAttribute?.('data-availability'),
          element.getAttribute?.('data-selectable'),
          element.className,
          element.textContent,
        ]).filter(Boolean).join(' ')}`);
        const disabled = related.some((element) => (
          element.hasAttribute?.('disabled')
          || element.getAttribute?.('aria-disabled') === 'true'
          || element.getAttribute?.('data-disabled') === 'true'
          || element.getAttribute?.('data-available') === 'false'
          || element.getAttribute?.('data-in-stock') === 'false'
          || element.getAttribute?.('data-selectable') === 'false'
          || element.getAttribute?.('data-stock') === '0'
        )) || unavailablePattern.test(stateText);
        const explicitAvailable = related.some((element) => (
          element.getAttribute?.('data-available') === 'true'
          || element.getAttribute?.('data-in-stock') === 'true'
          || element.getAttribute?.('data-selectable') === 'true'
        )) || availablePattern.test(stateText);
        const confidence = disabled || explicitAvailable ? 3 : visible(node) ? 2 : 1;
        const row = {
          size,
          text: size,
          disabled,
          available: !disabled,
          status: disabled ? 'SOLD_OUT' : 'IN_STOCK',
          quantity: disabled ? 0 : null,
          confidence,
        };
        const previous = bySize.get(size);
        if (!previous || row.confidence > previous.confidence || (row.confidence === previous.confidence && row.disabled && !previous.disabled)) {
          bySize.set(size, row);
        }
      };

      const roots = rootsNow();
      for (const root of roots) {
        for (const node of root.querySelectorAll(candidateSelector)) {
          const raw = clean(
            node.getAttribute?.('data-size')
            || node.getAttribute?.('data-value')
            || node.getAttribute?.('data-attr-value')
            || node.getAttribute?.('value')
            || node.getAttribute?.('aria-label')
            || node.textContent
            || '',
          );
          addCandidate(node, raw);
        }
      }

      if (!bySize.size) {
        for (const node of document.querySelectorAll(
          '#PDP-size-selector [data-size], #PDP-size-selector [data-value], #PDP-size-selector input, #PDP-size-selector option, [role="dialog"] [data-size], [role="dialog"] [data-value], [role="dialog"] [role="option"]',
        )) {
          const raw = clean(node.getAttribute?.('data-size') || node.getAttribute?.('data-value') || node.getAttribute?.('value') || node.getAttribute?.('aria-label') || node.textContent || '');
          addCandidate(node, raw);
        }
      }

      if (!bySize.size) {
        const source = document.documentElement?.innerHTML || '';
        const patterns = [
          /"displayValue"\s*:\s*"([^"]{1,20})"/gi,
          /"size"\s*:\s*"([^"]{1,20})"/gi,
          /data-size=(?:"|')([^"']{1,20})(?:"|')/gi,
        ];
        for (const pattern of patterns) {
          for (const match of source.matchAll(pattern)) {
            const index = match.index || 0;
            const snippet = source.slice(Math.max(0, index - 260), index + 420);
            if (!/size|variation|selectable|availability|inventory|stock/i.test(snippet)) continue;
            const synthetic = {
              getAttribute: (name) => {
                if (name === 'data-selectable' && /"selectable"\s*:\s*false/i.test(snippet)) return 'false';
                if (name === 'data-selectable' && /"selectable"\s*:\s*true/i.test(snippet)) return 'true';
                if (name === 'data-available' && /"available"\s*:\s*false/i.test(snippet)) return 'false';
                if (name === 'data-available' && /"available"\s*:\s*true/i.test(snippet)) return 'true';
                return null;
              },
              hasAttribute: () => false,
              parentElement: null,
              closest: () => null,
              className: '',
              textContent: match[1],
              getBoundingClientRect: () => ({ width: 0, height: 0 }),
            };
            addCandidate(synthetic, match[1], snippet);
          }
        }
      }

      const sizes = [...bySize.values()].map(({ confidence, ...row }) => row);
      return {
        sizes,
        debug: {
          buttonFound: Boolean(sizeButton),
          expanded: sizeButton?.getAttribute('aria-expanded') || null,
          controlledId,
          roots: roots.length,
          bodyId: document.body?.id || '',
          pageAction: window.pageAction || '',
          url: location.href,
        },
      };
    },
  });

  const fallback = injected?.[0]?.result || { sizes: [], debug: {} };
  if (Array.isArray(fallback.sizes) && fallback.sizes.length) {
    page.sizes = fallback.sizes;
  }
  page.sizeDebug = fallback.debug;
  log(
    `Size capture ${chrome.runtime.getManifest().version}: ${page.sizes?.length || 0} sizes; `
    + `button ${fallback.debug?.buttonFound ? 'yes' : 'no'}; expanded ${fallback.debug?.expanded || 'n/a'}; roots ${fallback.debug?.roots || 0}; `
    + `body ${fallback.debug?.bodyId || 'unknown'}; action ${fallback.debug?.pageAction || 'unknown'}`,
  );
  return page;
};

let parserVoConsecutiveSizeFailures = 0;
const captureProductBeforeSizeCircuitBreaker = captureProduct;

captureProduct = async function captureProductWithSizeCircuitBreaker(url, settingsValue, context) {
  const result = await captureProductBeforeSizeCircuitBreaker(url, settingsValue, context);
  const errorText = String(result?.error || '');
  if (result?.ok === false && /sizes were not captured|all sizes are sold out/i.test(errorText)) {
    parserVoConsecutiveSizeFailures += 1;
    if (parserVoConsecutiveSizeFailures >= 3 && context?.jobId) {
      stopRequested = true;
      await queueRequest(settingsValue, {
        action: 'error',
        jobId: context.jobId,
        productsTotal: stats.total || 0,
        productsDone: stats.captured || 0,
        productsFailed: stats.failed + 1,
        message: 'Chrome Capture stopped after 3 consecutive size-selector failures. Install the latest extension before restarting.',
        result: {
          version: chrome.runtime.getManifest().version,
          errors: logs.filter((line) => line.includes('ERROR')).slice(0, 20),
        },
      }).catch(() => {});
    }
  } else if (result?.ok !== false) {
    parserVoConsecutiveSizeFailures = 0;
  }
  return result;
};
