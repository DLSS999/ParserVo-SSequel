export type PricingInput = {
  supplierPrice: number;
  supplierOldPrice?: number | null;
  currency: string;
  eurRate: number;
  plnRate: number;
  markupPercent?: number;
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

function roundUp(value: number, step: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / step) * step;
}

function roundMoney(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getCurrencyRate(currency: string, eurRate: number, plnRate: number) {
  const normalized = String(currency || "").toUpperCase().trim();
  if (normalized === "EUR" || normalized === "€") return toDecimalNumber(eurRate, 45);
  if (normalized === "PLN" || normalized === "ZŁ" || normalized === "ZL") return toDecimalNumber(plnRate, 12.5);
  return 1;
}

function getCinqCoefficientByUahCost(costPriceUah: number) {
  if (costPriceUah <= 800) return 2.75;
  if (costPriceUah <= 1200) return 2.3;
  if (costPriceUah <= 1800) return 1.75;
  if (costPriceUah <= 2500) return 1.5;
  if (costPriceUah <= 5000) return 1.4;
  if (costPriceUah <= 10000) return 1.35;
  if (costPriceUah <= 30000) return 1.3;
  return 1.3;
}

export function calculatePricing(input: PricingInput) {
  const supplierPrice = toDecimalNumber(input.supplierPrice, 0);
  const exchangeRateUsed = getCurrencyRate(input.currency, input.eurRate, input.plnRate);
  const costPriceUah = roundMoney(supplierPrice * exchangeRateUsed);
  const salePriceUah = roundUp(costPriceUah * getCinqCoefficientByUahCost(costPriceUah), 10);

  const supplierOldPrice = toDecimalNumber(input.supplierOldPrice, 0);
  const oldCostPriceUah = roundMoney(supplierOldPrice * exchangeRateUsed);
  const compareCandidate = roundUp(oldCostPriceUah * getCinqCoefficientByUahCost(oldCostPriceUah), 10);
  const compareAtPriceUah = input.compareAtEnabled !== false && supplierOldPrice > supplierPrice && compareCandidate > salePriceUah
    ? compareCandidate
    : null;

  return {
    exchangeRateUsed,
    costPriceUah,
    salePriceUah,
    compareAtPriceUah,
  };
}

export function sortSizesForShopify(sizes: string[]) {
  const order = ["XXXS", "XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "ONE SIZE", "OS"];
  return [...sizes].sort((a, b) => {
    const aNorm = String(a).toUpperCase().trim();
    const bNorm = String(b).toUpperCase().trim();
    const aNumber = Number(aNorm.replace(',', '.'));
    const bNumber = Number(bNorm.replace(',', '.'));
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    const aIndex = order.indexOf(aNorm);
    const bIndex = order.indexOf(bNorm);
    if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
    if (aIndex >= 0) return -1;
    if (bIndex >= 0) return 1;
    return aNorm.localeCompare(bNorm);
  });
}
