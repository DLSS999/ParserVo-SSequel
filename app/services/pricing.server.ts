export type PricingInput = {
  supplierPrice: number;
  supplierOldPrice?: number | null;
  currency: string;
  eurRate: number;
  plnRate: number;
  markupPercent: number;
  roundingRule: string;
  compareAtEnabled: boolean;
  compareAtFormula?: string;
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
  const eur = toDecimalNumber(eurRate, 45);
  const pln = toDecimalNumber(plnRate, 12.5);

  if (normalized === "EUR" || normalized === "€") return eur;
  if (normalized === "PLN" || normalized === "ZŁ" || normalized === "ZL") return pln;

  return 1;
}

function isPlnCurrency(currency: string) {
  const normalized = String(currency || "").toUpperCase().trim();
  return normalized === "PLN" || normalized === "ZŁ" || normalized === "ZL" || normalized === "ZLOTY" || normalized === "ZLOTYCH";
}

function getCinqCoefficientByPlnPrice(pricePln: number) {
  if (pricePln <= 64) return 2.75;
  if (pricePln <= 96) return 2.3;
  if (pricePln <= 144) return 1.75;
  if (pricePln <= 200) return 1.5;
  if (pricePln <= 400) return 1.4;
  if (pricePln <= 800) return 1.35;
  if (pricePln <= 1600) return 1.35;
  if (pricePln <= 2400) return 1.3;
  if (pricePln <= 4000) return 1.3;
  if (pricePln <= 8000) return 1.3;
  return 1.3;
}

function getCinqCoefficientByUahCost(costPriceUah: number) {
  if (costPriceUah <= 800) return 2.75;
  if (costPriceUah <= 1200) return 2.3;
  if (costPriceUah <= 1800) return 1.75;
  if (costPriceUah <= 2500) return 1.5;
  if (costPriceUah <= 5000) return 1.4;
  if (costPriceUah <= 10000) return 1.35;
  if (costPriceUah <= 20000) return 1.35;
  if (costPriceUah <= 30000) return 1.3;
  if (costPriceUah <= 50000) return 1.3;
  if (costPriceUah <= 100000) return 1.3;
  return 1.3;
}

function getCinqCoefficient(priceInSupplierCurrency: number, currency: string, costPriceUah: number) {
  if (isPlnCurrency(currency)) return getCinqCoefficientByPlnPrice(priceInSupplierCurrency);
  return getCinqCoefficientByUahCost(costPriceUah);
}

export function calculatePricing(input: PricingInput) {
  const supplierPrice = toDecimalNumber(input.supplierPrice, 0);
  const exchangeRateUsed = getCurrencyRate(input.currency, input.eurRate, input.plnRate);

  const rawCostPriceUah = supplierPrice * exchangeRateUsed;
  const costPriceUah = roundMoney(rawCostPriceUah);
  const coefficient = getCinqCoefficient(supplierPrice, input.currency, costPriceUah);
  const salePriceUah = roundUp(costPriceUah * coefficient, 10);

  const supplierOldPrice = toDecimalNumber(input.supplierOldPrice, 0);
  const oldCostPriceUah = roundMoney(supplierOldPrice * exchangeRateUsed);
  const oldCoefficient = getCinqCoefficient(supplierOldPrice, input.currency, oldCostPriceUah);
  const calculatedCompareAtPriceUah = roundUp(oldCostPriceUah * oldCoefficient, 10);
  const compareAtPriceUah = input.compareAtEnabled && supplierOldPrice > supplierPrice && calculatedCompareAtPriceUah > salePriceUah
    ? calculatedCompareAtPriceUah
    : null;

  return {
    exchangeRateUsed,
    costPriceUah,
    salePriceUah,
    compareAtPriceUah,
  };
}
