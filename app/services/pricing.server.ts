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
  const raw = String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.-]/g, "");
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

function calculateSale(costPriceUah: number, roundingRule: string) {
  return roundPrice(costPriceUah + 5000, roundingRule);
}

export function calculatePricing(input: PricingInput) {
  const supplierPrice = Math.max(0, toDecimalNumber(input.supplierPrice, 0));
  const exchangeRateUsed = getCurrencyRate(input.currency, input.eurRate, input.plnRate);
  const roundingRule = input.roundingRule || "round_to_5";
  const costPriceUah = roundPrice(supplierPrice * exchangeRateUsed, roundingRule);
  const salePriceUah = calculateSale(costPriceUah, roundingRule);

  const supplierOldPrice = Math.max(0, toDecimalNumber(input.supplierOldPrice, 0));
  const compareAtPriceUah = input.compareAtEnabled !== false && supplierOldPrice > supplierPrice
    ? Math.max(
        salePriceUah,
        calculateSale(roundPrice(supplierOldPrice * exchangeRateUsed, roundingRule), roundingRule),
      )
    : null;

  return {
    exchangeRateUsed,
    costPriceUah,
    salePriceUah,
    compareAtPriceUah,
    supplierPrice,
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
