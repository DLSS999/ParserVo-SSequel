export type PricingInput = {
  supplierPrice: number;
  supplierOldPrice?: number | null;
  currency: string;
  eurRate: number;
  plnRate: number;
  roundingRule?: string;
  compareAtEnabled?: boolean;
};

export function toDecimalNumber(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const source = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  const match = source.match(/-?[0-9][0-9\s.,]*/);
  if (!match) return fallback;

  let raw = match[0]
    .replace(/\s+/g, "")
    .replace(/[.,]+$/g, "");
  if (!raw || raw === "-") return fallback;

  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    raw = raw.replace(thousands, "").replace(decimal, ".");
  } else if (comma >= 0) {
    const decimals = raw.length - comma - 1;
    raw = decimals === 2
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (dot >= 0) {
    const decimals = raw.length - dot - 1;
    if (decimals !== 2) raw = raw.replace(/\./g, "");
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value: unknown, fallback: number) {
  const parsed = toDecimalNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function roundUp(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function roundPrice(value: number, rule: string) {
  if (rule === "round_to_5") return roundUp(value, 5);
  if (rule === "round_to_10") return roundUp(value, 10);
  if (rule === "round_to_50") return roundUp(value, 50);
  if (rule === "round_to_100") return roundUp(value, 100);
  if (rule === "round_to_500") return roundUp(value, 500);
  return Math.round(value);
}

function getCurrencyRate(currency: string, eurRate: number, plnRate: number) {
  const normalized = String(currency || "").toUpperCase().trim();
  if (normalized === "EUR" || normalized === "€") return positive(eurRate, 55);
  if (normalized === "PLN" || normalized === "ZŁ" || normalized === "ZL") return positive(plnRate, 12.19);
  return 1;
}

export function markupCoefficient(costPriceUah: number) {
  if (costPriceUah <= 5_000) return 1.7;
  if (costPriceUah <= 7_500) return 1.6;
  if (costPriceUah <= 10_000) return 1.5;
  if (costPriceUah <= 15_000) return 1.4;
  if (costPriceUah <= 20_000) return 1.35;
  if (costPriceUah <= 30_000) return 1.3;
  if (costPriceUah <= 50_000) return 1.25;
  if (costPriceUah <= 75_000) return 1.2;
  return 1.15;
}

function calculateRetailPrice(costPriceUah: number, roundingRule: string) {
  const coefficient = markupCoefficient(costPriceUah);
  return {
    coefficient,
    retailPriceUah: roundPrice(costPriceUah * coefficient, roundingRule),
  };
}

function normalizeSupplierOldPrice(value: unknown, supplierPrice: number) {
  let oldPrice = Math.max(0, toDecimalNumber(value, 0));
  if (!oldPrice || !supplierPrice || oldPrice <= supplierPrice) return oldPrice;

  // A trailing separator from strings such as "985,00 ," previously produced
  // 98,500. Recover the intended old price only when the corrected value is a
  // plausible compare-at price. Otherwise reject the anomalous value entirely.
  if (oldPrice / supplierPrice > 8) {
    for (const divisor of [100, 1_000, 10]) {
      const candidate = oldPrice / divisor;
      const ratio = candidate / supplierPrice;
      if (candidate > supplierPrice && ratio > 1 && ratio <= 8) {
        oldPrice = candidate;
        break;
      }
    }
  }

  return oldPrice / supplierPrice <= 8 ? oldPrice : 0;
}

export function calculatePricing(input: PricingInput) {
  const supplierPrice = Math.max(0, toDecimalNumber(input.supplierPrice, 0));
  const exchangeRateUsed = getCurrencyRate(input.currency, input.eurRate, input.plnRate);
  const roundingRule = input.roundingRule || "round_to_5";
  const costPriceUah = roundPrice(supplierPrice * exchangeRateUsed, roundingRule);
  const currentPricing = calculateRetailPrice(costPriceUah, roundingRule);
  const salePriceUah = currentPricing.retailPriceUah;

  const supplierOldPrice = normalizeSupplierOldPrice(input.supplierOldPrice, supplierPrice);
  const oldCostPriceUah = supplierOldPrice > supplierPrice
    ? roundPrice(supplierOldPrice * exchangeRateUsed, roundingRule)
    : null;
  const oldPricing = oldCostPriceUah
    ? calculateRetailPrice(oldCostPriceUah, roundingRule)
    : null;
  const compareAtPriceUah = input.compareAtEnabled !== false && oldPricing
    ? Math.max(salePriceUah, oldPricing.retailPriceUah)
    : null;

  return {
    exchangeRateUsed,
    costPriceUah,
    salePriceUah,
    compareAtPriceUah,
    supplierPrice,
    supplierOldPrice: supplierOldPrice || null,
    oldCostPriceUah,
    coefficient: currentPricing.coefficient,
    compareAtCoefficient: oldPricing?.coefficient ?? null,
    markupUah: salePriceUah - costPriceUah,
    compareAtMarkupUah: compareAtPriceUah && oldCostPriceUah
      ? compareAtPriceUah - oldCostPriceUah
      : null,
    profitUah: salePriceUah - costPriceUah,
    discountAmountUah: compareAtPriceUah ? compareAtPriceUah - salePriceUah : null,
    roundingRule,
  };
}

function numericSize(value: string) {
  const match = String(value || "").toUpperCase().match(/^(?:IT|EU|FR|UK|US)?\s*(\d+(?:\.5)?)$/);
  return match ? Number(match[1]) : Number.NaN;
}

export function sortSizesForShopify(sizes: string[]) {
  const order = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "ONE SIZE", "OS"];
  return [...new Set(sizes.map((size) => String(size).trim()).filter(Boolean))].sort((a, b) => {
    const aNorm = a.toUpperCase();
    const bNorm = b.toUpperCase();
    const aNumber = numericSize(aNorm);
    const bNumber = numericSize(bNorm);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    const aIndex = order.indexOf(aNorm);
    const bIndex = order.indexOf(bNorm);
    if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
    if (aIndex >= 0) return -1;
    if (bIndex >= 0) return 1;
    return aNorm.localeCompare(bNorm);
  });
}
