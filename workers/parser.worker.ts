import { Worker } from "bullmq";
import IORedis from "ioredis";
import path from "node:path";
import { StoneIslandParser } from "../app/parsers/stone-island";
import { runParser } from "../app/parsers/core/runner";

const redisUrl=process.env.REDIS_URL;
if (!redisUrl) {
  console.log("REDIS_URL is not set. Worker is disabled; use npm run crawl:stone-island for local runs.");
  process.exit(0);
}
const connection=new IORedis(redisUrl,{maxRetriesPerRequest:null});
const worker=new Worker("parservo", async job => {
  if (job.name !== "stone-island") throw new Error(`Unknown parser job: ${job.name}`);
  return runParser(new StoneIslandParser(), {
    catalogUrl: job.data.catalogUrl || process.env.STONE_ISLAND_CATALOG_URL,
    maxProducts: Number(job.data.maxProducts || 0), concurrency:Number(job.data.concurrency || 3),
    headless: job.data.headless !== false, outputDir:path.resolve(job.data.outputDir || "data/stone-island"),
  });
},{connection,concurrency:1});
worker.on("completed",job=>console.log(`Job ${job.id} completed`));
worker.on("failed",(job,error)=>console.error(`Job ${job?.id} failed`,error));
console.log("ParserVo worker ready");
