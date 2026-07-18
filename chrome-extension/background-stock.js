importScripts("background-loader.js");

const readStoneProductBeforeStockAudit = readStoneProduct;

readStoneProduct = async function readStoneProductWithStrictStockAudit(tabId) {
  const page = await readStoneProductBeforeStockAudit(tabId);

  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const normalizeSize = (value) => {
        const raw = clean(value);
        const match = raw.match(
          /(?:^|\b)(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|ONE\s*SIZE|OS|(?:IT|EU|FR|UK|US)?\s*\d{1,3}(?:[.,]5)?)(?:\b|$)/i,
        );
        return clean(match?.[1] || "").toUpperCase().replace(",", ".");
      };

      const sizeButton = document.querySelector(
        '#sizes-combobox, [aria-controls="PDP-size-selector-options"], .selector-size-dropdown__button',
      );
      const hasSizeSelector = Boolean(sizeButton || document.querySelector("#PDP-size-selector-options"));

      if (sizeButton) {
        try {
          sizeButton.scrollIntoView({ block: "center", behavior: "auto" });
          await wait(250);
          if (sizeButton.getAttribute("aria-expanded") !== "true") sizeButton.click();
        } catch {}
      }

      const candidateSelector = [
        '#PDP-size-selector-options [role="option"]',
        '#PDP-size-selector-options button',
        '#PDP-size-selector-options label',
        '#PDP-size-selector-options li',
        '#PDP-size-selector-options input',
        '#PDP-size-selector-options option',
        '[role="listbox"] [role="option"]',
        'select[name*="size" i] option',
      ].join(", ");

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && document.querySelectorAll(candidateSelector).length === 0) {
        await wait(250);
      }

      const bySize = new Map();
      const unavailablePattern = /disabled|unavailable|not\s*available|sold.?out|out.?of.?stock|coming\s*soon|no\s*stock/i;
      const availablePattern = /in.?stock|available|add\s+to\s+(?:bag|basket)/i;

      const inspectCandidate = (node) => {
        const interactive = node.matches?.("input,button,option,[role='option']")
          ? node
          : node.querySelector?.("input,button,option,[role='option']") || node;
        const item = node.closest?.("li, label, [role='option'], .selector__menu-listitem, .selector__menu__item") || node;
        const related = [interactive, node, item, item?.parentElement].filter(Boolean);

        const raw = clean(
          interactive?.getAttribute?.("data-size")
          || interactive?.getAttribute?.("value")
          || interactive?.getAttribute?.("aria-label")
          || node.getAttribute?.("data-size")
          || node.getAttribute?.("value")
          || node.getAttribute?.("aria-label")
          || node.textContent
          || "",
        );
        const size = normalizeSize(raw);
        if (!size || /select\s+size/i.test(raw)) return null;

        const stateText = clean(related.flatMap((element) => [
          element.getAttribute?.("aria-label"),
          element.getAttribute?.("title"),
          element.getAttribute?.("data-status"),
          element.getAttribute?.("data-stock-status"),
          element.getAttribute?.("data-availability"),
          element.getAttribute?.("data-testid"),
          element.className,
          element.textContent,
        ]).filter(Boolean).join(" "));

        const disabledAncestor = interactive?.closest?.([
          "[disabled]",
          '[aria-disabled="true"]',
          '[data-disabled="true"]',
          '[data-available="false"]',
          '[data-in-stock="false"]',
          '[data-stock="0"]',
          '[class*="disabled" i]',
          '[class*="unavailable" i]',
          '[class*="sold" i]',
          '[class*="out-of-stock" i]',
          '[class*="outOfStock" i]',
        ].join(", "));

        const attributeSoldOut = related.some((element) => (
          element.hasAttribute?.("disabled")
          || element.getAttribute?.("aria-disabled") === "true"
          || element.getAttribute?.("data-disabled") === "true"
          || element.getAttribute?.("data-available") === "false"
          || element.getAttribute?.("data-in-stock") === "false"
          || element.getAttribute?.("data-stock") === "0"
        ));

        const attributeAvailable = related.some((element) => (
          element.getAttribute?.("data-available") === "true"
          || element.getAttribute?.("data-in-stock") === "true"
          || /^(?:in.?stock|available)$/i.test(clean(element.getAttribute?.("data-status")))
        ));

        let pointerDisabled = false;
        try {
          const targets = [interactive, item].filter(Boolean);
          pointerDisabled = targets.some((element) => window.getComputedStyle(element).pointerEvents === "none");
        } catch {}

        const explicitSoldOut = Boolean(attributeSoldOut || disabledAncestor || unavailablePattern.test(stateText));
        const explicitAvailable = Boolean(attributeAvailable || availablePattern.test(stateText));
        const disabled = explicitSoldOut || (!explicitAvailable && pointerDisabled);
        const confidence = explicitSoldOut || explicitAvailable ? 3 : pointerDisabled ? 2 : 1;

        return {
          size,
          text: size,
          disabled,
          available: !disabled,
          status: disabled ? "SOLD_OUT" : "IN_STOCK",
          quantity: disabled ? 0 : null,
          confidence,
        };
      };

      for (const node of document.querySelectorAll(candidateSelector)) {
        const candidate = inspectCandidate(node);
        if (!candidate) continue;
        const previous = bySize.get(candidate.size);
        if (!previous
          || candidate.confidence > previous.confidence
          || (candidate.confidence === previous.confidence && candidate.disabled && !previous.disabled)) {
          bySize.set(candidate.size, candidate);
        }
      }

      const sizes = [...bySize.values()].map(({ confidence, ...row }) => row);
      const productSoldOut = /sold.?out|out.?of.?stock|currently\s+unavailable/i.test(clean(
        document.querySelector(
          '[data-testid*="sold-out" i], .product-selection__sold-out, [class*="sold-out" i], [class*="out-of-stock" i]',
        )?.textContent || "",
      ));

      return { hasSizeSelector, sizes, productSoldOut };
    },
  });

  const audit = injected?.[0]?.result || { hasSizeSelector: false, sizes: [], productSoldOut: false };
  const auditedSizes = Array.isArray(audit.sizes) ? audit.sizes : [];
  if (audit.hasSizeSelector && auditedSizes.length) {
    page.sizes = auditedSizes;
  }
  if (audit.productSoldOut) page.productAvailable = false;

  const rows = Array.isArray(page.sizes) ? page.sizes : [];
  const soldOut = rows.filter((row) => row.disabled || row.available === false || row.quantity === 0).length;
  const available = rows.length - soldOut;
  log(`Stock audit ${chrome.runtime.getManifest().version}: available sizes ${available}; sold out ${soldOut}`);

  return page;
};
