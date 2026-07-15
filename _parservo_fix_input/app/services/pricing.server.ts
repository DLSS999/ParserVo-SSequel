export type PricingInput = {
  supplierPrice: number;
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
  const eur = toDecimalNumber(eurRate, 45);
  const pln = toDecimalNumber(plnRate, 12.19);

  if (normalized === "EUR" || normalized === "€") return eur;
  if (normalized === "PLN" || normalized === "ZŁ" || normalized === "ZL") return pln;

  return 1;
}

/*
  Custom CINQ pricing formula v2.

  Important: rates can be entered as 12,19 or 12.19. ParserVo normalizes both formats.

  Correct test case from Vitkac:
  supplierPrice = 2899 PLN
  PLN rate = 12.19
  cost = 2899 * 12.19 = 35338.81 -> round to 5 = 35340
  sale = (35340 + 5000) * 1.05 = 42357 -> round to 5 = 42360
  compare-at = 73500 for this pricing level
*/
function calculateCinqSalePrice(costPriceUah: number, roundingRule: string) {
  let fixedProfit = 5000;

  if (costPriceUah > 50000 && costPriceUah <= 100000) {
    fixedProfit = 10000;
  }

  if (costPriceUah > 100000) {
    fixedProfit = 20000;
  }

  return roundPrice((costPriceUah + fixedProfit) * 1.05, roundingRule);
}

function calculateCinqCompareAtPrice(costPriceUah: number, salePriceUah: number, roundingRule: string) {
  const compareAt = costPriceUah * (73500 / 35340);
  const rounded = roundPrice(compareAt, roundingRule);

  return Math.max(rounded, salePriceUah);
}

export function calculatePricing(input: PricingInput) {
  const supplierPrice = toDecimalNumber(input.supplierPrice, 0);
  const exchangeRateUsed = getCurrencyRate(input.currency, input.eurRate, input.plnRate);
  const roundingRule = input.roundingRule || "round_to_5";

  const costPriceUah = roundPrice(supplierPrice * exchangeRateUsed, roundingRule);
  const salePriceUah = calculateCinqSalePrice(costPriceUah, roundingRule);

  const compareAtPriceUah = input.compareAtEnabled
    ? calculateCinqCompareAtPrice(costPriceUah, salePriceUah, roundingRule)
    : null;

  return {
    exchangeRateUsed,
    costPriceUah,
    salePriceUah,
    compareAtPriceUah,
  };
}
