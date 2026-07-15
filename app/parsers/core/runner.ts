import type { MarketplaceParser, ParserProduct, ParserRunOptions } from "./types";
import { writeRunOutput } from "./utils";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const result = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

export async function runParser(parser: MarketplaceParser, options: ParserRunOptions) {
  const urls = await parser.collectProductUrls(options);
  const selected = options.maxProducts > 0 ? urls.slice(0, options.maxProducts) : urls;
  console.log(`[${parser.source}] found ${urls.length}; selected ${selected.length}`);
  const errors: Array<{ url: string; error: string }> = [];
  const rows = await mapLimit(selected, options.concurrency, async (url, index) => {
    try {
      console.log(`[${parser.source}] ${index + 1}/${selected.length} ${url}`);
      return await parser.parseProduct(url, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ url, error: message });
      console.error(`[${parser.source}] failed ${url}: ${message}`);
      return null;
    }
  });
  const products = rows.filter((row): row is ParserProduct => Boolean(row));
  await writeRunOutput(options.outputDir, products, errors);
  return { products, errors, urls };
}
