import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParserProduct } from "./types";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function slug(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
}

export function parseMoney(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const clean = String(value || "").replace(/\s/g, "").replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function uniq<T>(items: T[]) { return [...new Set(items)]; }

export async function writeRunOutput(outputDir: string, products: ParserProduct[], errors: unknown[]) {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "products.json"), JSON.stringify(products, null, 2), "utf8"),
    writeFile(path.join(outputDir, "errors.json"), JSON.stringify(errors, null, 2), "utf8"),
    writeFile(path.join(outputDir, "summary.json"), JSON.stringify({
      generatedAt: new Date().toISOString(), products: products.length, errors: errors.length,
      variants: products.reduce((sum, p) => sum + p.variants.length, 0),
    }, null, 2), "utf8"),
  ]);
}
