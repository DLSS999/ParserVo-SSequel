import { detectSupplier as detectVitkac, parseVitkacProduct, parseVitkacProductFromHtml, type ParsedSupplierProduct } from "./vitkac.server";
import { parseStoneIslandProduct, parseStoneIslandProductFromHtml } from "./stone-island.server";

export type SupplierKind = "Vitkac" | "Stone Island";

export function detectSupplier(url: string): SupplierKind | null {
  const value = url.toLowerCase();
  if (value.includes("stoneisland.com")) return "Stone Island";
  return detectVitkac(url) as SupplierKind | null;
}

export async function parseSupplierProduct(url: string, html?: string): Promise<ParsedSupplierProduct> {
  const supplier = detectSupplier(url);
  if (!supplier) throw new Error("Unsupported supplier URL.");
  if (supplier === "Stone Island") return html && html.length > 1000 ? parseStoneIslandProductFromHtml(url, html) : parseStoneIslandProduct(url);
  return html && html.length > 1000 ? parseVitkacProductFromHtml(url, html) : parseVitkacProduct(url);
}
