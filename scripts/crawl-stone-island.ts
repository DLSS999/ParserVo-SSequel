import path from "node:path";
import { StoneIslandParser } from "../app/parsers/stone-island";
import { runParser } from "../app/parsers/core/runner";

const catalogUrl=process.env.STONE_ISLAND_CATALOG_URL || "https://www.stoneisland.com/en-gb/men/sales/view-all-sales";
const outputDir=path.resolve(process.env.OUTPUT_DIR || "data/stone-island");
const result=await runParser(new StoneIslandParser(), {
  catalogUrl,
  maxProducts: Math.max(0, Number(process.env.MAX_PRODUCTS || 0)),
  concurrency: Math.max(1, Math.min(6, Number(process.env.CRAWL_CONCURRENCY || 3))),
  headless: process.env.HEADLESS !== "false",
  outputDir,
});
console.log(`Stone Island complete: ${result.products.length} products, ${result.errors.length} errors`);
if (result.errors.length && !result.products.length) process.exitCode=1;
