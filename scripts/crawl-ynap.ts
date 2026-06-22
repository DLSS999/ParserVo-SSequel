import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import { calculatePricing } from "../app/services/pricing.server";
import { categoryUrl, selectCategories, type CrawlCategory } from "./ynap-config";
import {
  markMissingProducts,
  startCrawlRun,
  updateCrawlRun,
  upsertProduct,
  type CrawledMedia,
  type CrawledProduct,
  type CrawledVariant,
} from "./supabase-catalog-writer";

const concurrency = Math.max(1, Math.min(8, Number(process.env.CRAWL_CONCURRENCY || 4)));
const maxProducts = Math.max(0, Number(process.env.MAX_PRODUCTS || 0));
const eurRate = Number(process.env.EUR_RATE || 45);
const plnRate = Number(process.env.PLN_RATE || 12.19);
const debugDir = path.resolve("crawl-debug");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function cleanTitle(value: string) {
  return value
    .replace(/\s*\|\s*(NET-A-PORTER|MR PORTER).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBrand(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function allowedBrand(brand: string, config: CrawlCategory) {
  const normalized = normalizeBrand(brand);
  return config.brands.some((item) => normalizeBrand(item) === normalized);
}

function parseMoney(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "")
    .replace(/\s/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

const sizeMap: Array<[RegExp, string]> = [
  [/^(?:xxx\s*small|3xs)$/i, "XXXS"],
  [/^(?:xx\s*small|2xs)$/i, "XXS"],
  [/^(?:x\s*small|xs)$/i, "XS"],
  [/^(?:small|s)$/i, "S"],
  [/^(?:medium|m)$/i, "M"],
  [/^(?:large|l)$/i, "L"],
  [/^(?:x\s*large|xl)$/i, "XL"],
  [/^(?:xx\s*large|2xl|xxl)$/i, "2XL"],
  [/^(?:xxx\s*large|3xl|xxxl)$/i, "3XL"],
  [/^(?:one\s*size|os)$/i, "ONE SIZE"],
];

function normalizeSize(value: string) {
  let clean = value
    .replace(/\s*[-–—:|]\s*(sold out|low stock|only \d+ left|last one|unavailable|out of stock).*$/i, "")
    .replace(/^size\s*/i, "")
    .trim();
  clean = clean.replace(/^(EU|UK|US)\s+/i, "").trim();
  for (const [pattern, normalized] of sizeMap) {
    if (pattern.test(clean)) return normalized;
  }
  if (/^\d{1,3}(?:\.5)?$/.test(clean)) return clean;
  if (/^[A-Z]{1,4}$/.test(clean.toUpperCase())) return clean.toUpperCase();
  return null;
}

type RawSize = { text: string; disabled?: boolean };

function variantsFromRows(rows: RawSize[], config: CrawlCategory) {
  const bySize = new Map<string, CrawledVariant>();
  for (const row of rows) {
    const line = String(row.text || "").trim();
    if (!line || line.length > 90) continue;
    const size = normalizeSize(line);
    if (!size) continue;
    const soldOut = Boolean(row.disabled) || /sold out|unavailable|out of stock/i.test(line);
    const lowStock = /low stock|only\s*1|last one/i.test(line);
    const variant: CrawledVariant = {
      size,
      quantity: soldOut ? 0 : lowStock ? 1 : 5,
      available: !soldOut,
      status: soldOut ? "SOLD_OUT" : lowStock ? "LOW_STOCK" : "IN_STOCK",
      position: bySize.size + 1,
    };
    const previous = bySize.get(size);
    if (!previous || previous.status === "IN_STOCK" || soldOut || lowStock) bySize.set(size, variant);
  }

  if (!bySize.size && /bags|accessories/i.test(config.category)) {
    bySize.set("ONE SIZE", {
      size: "ONE SIZE",
      quantity: 5,
      available: true,
      status: "IN_STOCK",
      position: 1,
    });
  }

  return [...bySize.values()].map((variant, index) => ({ ...variant, position: index + 1 }));
}

function normalizeProductUrl(candidate: string, baseUrl: string) {
  const cleaned = candidate
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/["'<>),;]+$/g, "")
    .trim();

  if (!cleaned || !cleaned.includes("/product/")) return null;
  try {
    const url = new URL(cleaned, baseUrl);
    if (!/(net-a-porter\.com|mrporter\.com)$/i.test(url.hostname)) return null;
    if (!url.pathname.includes("/product/")) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractProductLinks(text: string, baseUrl: string) {
  const normalized = text
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const candidates = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s"'<>]+\/product\/[^\s"'<>\\]+/gi,
    /\/(?:en-[a-z]{2}|[a-z]{2}-[a-z]{2})\/(?:shop\/|mens\/)?product\/[^\s"'<>\\]+/gi,
    /\/(?:shop\/|mens\/)?product\/[^\s"'<>\\]+/gi,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const link = normalizeProductUrl(match[0], baseUrl);
      if (link) candidates.add(link);
    }
  }
  return [...candidates];
}

async function dismissBanners(page: Page) {
  for (const label of ["Accept all", "Accept All", "Allow all", "I agree", "Continue", "Close"]) {
    try {
      const button = page.getByRole("button", { name: label, exact: false }).first();
      if (await button.isVisible({ timeout: 600 })) await button.click({ timeout: 1500 });
    } catch {
      // Banner not present.
    }
  }
}

async function gotoWithRetry(page: Page, url: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()} for ${url}`);
      await dismissBanners(page);
      return response;
    } catch (error) {
      lastError = error;
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

async function saveDebug(page: Page, config: CrawlCategory, pageNumber: number, note: string) {
  await mkdir(debugDir, { recursive: true });
  const prefix = path.join(debugDir, `${config.id}-page-${pageNumber}`);
  const html = await page.content().catch(() => "");
  const body = await page.locator("body").innerText().catch(() => "");
  const info = [
    `note=${note}`,
    `title=${await page.title().catch(() => "")}`,
    `url=${page.url()}`,
    `body=${body.slice(0, 4000)}`,
  ].join("\n\n");
  await Promise.all([
    writeFile(`${prefix}.html`, html, "utf8"),
    writeFile(`${prefix}.txt`, info, "utf8"),
    page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => undefined),
  ]);
}

async function linksFromDom(page: Page) {
  const snapshot = await page.evaluate(() => {
    const values: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("*")) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.value && /product/i.test(attribute.value)) values.push(attribute.value);
      }
    }
    return {
      values,
      html: document.documentElement?.outerHTML || "",
      body: document.body?.innerText || "",
      title: document.title,
    };
  });
  return snapshot;
}

async function collectLinks(context: BrowserContext, config: CrawlCategory, runId: string) {
  const page = await context.newPage();
  const links = new Set<string>();
  const networkLinks = new Set<string>();

  const inspectResponse = async (response: Response) => {
    try {
      const contentType = response.headers()["content-type"] || "";
      const url = response.url();
      if (!/(json|javascript|html|text)/i.test(contentType) && !/(search|listing|product|graphql|api)/i.test(url)) return;
      const contentLength = Number(response.headers()["content-length"] || 0);
      if (contentLength > 8_000_000) return;
      const text = await response.text();
      for (const link of extractProductLinks(text, page.url() || config.baseUrl)) networkLinks.add(link);
    } catch {
      // Some response bodies are unavailable after navigation.
    }
  };

  page.on("response", (response) => void inspectResponse(response));

  try {
    for (let pageNumber = 1; pageNumber <= config.pages; pageNumber += 1) {
      const url = categoryUrl(config, pageNumber);
      console.log(`[${config.id}] category page ${pageNumber}/${config.pages}: ${url}`);
      const response = await gotoWithRetry(page, url);
      await page.waitForTimeout(4500);

      try {
        await page.waitForSelector('a[href*="/product/"]', { timeout: 8000 });
      } catch {
        // Links may live in serialized JSON instead of rendered anchors.
      }

      let previousHeight = 0;
      for (let step = 0; step < 12; step += 1) {
        const height = await page.evaluate(() => document.body.scrollHeight);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);
        if (height === previousHeight && step >= 4) break;
        previousHeight = height;
      }

      const snapshot = await linksFromDom(page);
      const pageLinks = new Set<string>();
      for (const value of snapshot.values) {
        const link = normalizeProductUrl(value, page.url());
        if (link) pageLinks.add(link);
      }
      for (const link of extractProductLinks(snapshot.html, page.url())) pageLinks.add(link);
      for (const link of extractProductLinks(snapshot.body, page.url())) pageLinks.add(link);
      for (const link of networkLinks) pageLinks.add(link);
      for (const link of pageLinks) links.add(link);

      const bodyStart = snapshot.body.replace(/\s+/g, " ").slice(0, 500);
      console.log(
        `[${config.id}] status=${response?.status() ?? "?"} title=${JSON.stringify(snapshot.title)} ` +
        `pageLinks=${pageLinks.size} unique=${links.size} body=${JSON.stringify(bodyStart)}`,
      );

      if (pageLinks.size === 0) {
        await saveDebug(page, config, pageNumber, "No product links found");
      }

      await updateCrawlRun(runId, {
        pages_done: pageNumber,
        links_found: links.size,
        status: "COLLECTING_LINKS",
        message: `Page ${pageNumber}: ${pageLinks.size} links; unique ${links.size}; title ${snapshot.title}`,
      });

      if (maxProducts > 0 && links.size >= maxProducts) break;
    }
  } finally {
    page.removeAllListeners("response");
    await page.close();
  }

  if (!links.size) {
    throw new Error(
      `No product links found for ${config.id}. The category pages were reachable but returned no product URLs. ` +
      `See the crawl-debug artifact for HTML, screenshot and page text.`,
    );
  }

  const all = [...links];
  return maxProducts > 0 ? all.slice(0, maxProducts) : all;
}

async function parsePage(page: Page, url: string, config: CrawlCategory): Promise<CrawledProduct> {
  await gotoWithRetry(page, url);
  await page.waitForTimeout(1500);

  const raw = await page.evaluate(() => {
    const meta = (name: string) =>
      document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute("content") || "";

    const jsonLd: unknown[] = [];
    for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
      try {
        jsonLd.push(JSON.parse(script.textContent || "null"));
      } catch {
        // Ignore invalid JSON-LD.
      }
    }

    const flatten = (value: any): any[] => {
      if (!value) return [];
      if (Array.isArray(value)) return value.flatMap(flatten);
      if (Array.isArray(value["@graph"])) return [value, ...value["@graph"].flatMap(flatten)];
      return [value];
    };
    const productLd = jsonLd.flatMap(flatten).find((item) => {
      const type = item?.["@type"];
      return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    }) || {};

    const bodyLines = (document.body?.innerText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const sizeRows: Array<{ text: string; disabled: boolean }> = [];
    let inSizeArea = false;
    for (const line of bodyLines) {
      if (/^select a size$/i.test(line) || /^size$/i.test(line)) {
        inSizeArea = true;
        continue;
      }
      if (inSizeArea && /^(add to bag|add to basket|add to wish list|editors.? notes)$/i.test(line)) break;
      if (inSizeArea && line.length <= 90) sizeRows.push({ text: line, disabled: /sold out|unavailable/i.test(line) });
    }

    for (const node of document.querySelectorAll<HTMLElement>(
      '[data-testid*="size" i], [aria-label*="size" i], [role="option"], button[class*="size" i]',
    )) {
      const text = (node.innerText || node.getAttribute("aria-label") || "").trim();
      const disabled =
        node.hasAttribute("disabled") ||
        node.getAttribute("aria-disabled") === "true" ||
        /disabled|sold.?out|unavailable/i.test(node.className);
      if (text && text.length <= 90) sizeRows.push({ text, disabled });
    }

    const imageCandidates = [...document.querySelectorAll<HTMLImageElement>("img")]
      .map((image) => {
        const srcset = image.getAttribute("srcset") || "";
        const lastSrcset = srcset.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).pop();
        return {
          url: image.currentSrc || lastSrcset || image.src || "",
          alt: image.alt || "",
        };
      })
      .filter((item) => item.url);

    const videoCandidates = [
      ...document.querySelectorAll<HTMLVideoElement>("video[src]"),
      ...document.querySelectorAll<HTMLSourceElement>("video source[src]"),
    ].map((node) => ({
      url: node.getAttribute("src") || "",
      alt: "Product video",
    })).filter((item) => item.url);

    const offer = Array.isArray(productLd.offers) ? productLd.offers[0] : productLd.offers || {};
    const brand = typeof productLd.brand === "object" ? productLd.brand?.name : productLd.brand;
    const priceText = bodyLines.find((line) => /€\s*[\d,.]+/.test(line)) || "";
    const compareText = [...document.querySelectorAll<HTMLElement>("del, s, [class*='oldPrice'], [class*='OriginalPrice']")]
      .map((node) => node.innerText.trim())
      .find(Boolean) || "";

    const colorLine = bodyLines.find((line) => /^color\s*:/i.test(line)) || "";
    const compositionLines = bodyLines.filter((line) => /\d+%\s+[a-z]/i.test(line)).slice(0, 5);

    return {
      title: productLd.name || meta("og:title") || document.querySelector("h1")?.textContent || "",
      brand: brand || "",
      description: productLd.description || meta("og:description") || "",
      currency: offer.priceCurrency || "EUR",
      price: offer.price || priceText,
      compareAt: compareText,
      color: colorLine.replace(/^color\s*:\s*/i, ""),
      composition: compositionLines.join("; "),
      sizeRows,
      images: [
        ...(Array.isArray(productLd.image) ? productLd.image.map((url: string) => ({ url, alt: "" })) : productLd.image ? [{ url: productLd.image, alt: "" }] : []),
        { url: meta("og:image"), alt: "" },
        ...imageCandidates,
      ],
      videos: videoCandidates,
      bodySample: bodyLines.slice(-120),
    };
  });

  const title = cleanTitle(String(raw.title || ""));
  let brand = String(raw.brand || "").trim();
  if (!brand) {
    brand = config.brands.find((item) => normalizeBrand(title).startsWith(normalizeBrand(item))) || "Unknown";
  }
  if (!allowedBrand(brand, config)) throw new Error(`Brand outside filter: ${brand}`);

  const supplierPrice = parseMoney(raw.price);
  if (!supplierPrice || supplierPrice > 2000) throw new Error(`Price outside filter: ${supplierPrice}`);
  const compareAtPrice = parseMoney(raw.compareAt) || null;
  const variants = variantsFromRows(raw.sizeRows, config);
  if (!variants.length) throw new Error("No product variants detected");
  const productCode = new URL(url).pathname.split("/").filter(Boolean).pop() || slug(title);
  const pathParts = new URL(url).pathname.split("/").filter(Boolean);
  const productSlug = pathParts[pathParts.length - 2] || slug(title);
  const handle = slug(`${productSlug}-${productCode}`);

  const imageRows = (raw.images as Array<{ url: string; alt: string }>)
    .filter((item) => /^https?:\/\//i.test(item.url))
    .filter((item) => !/logo|icon|sprite|flag|qr|newsletter/i.test(item.url))
    .filter((item) => !/w(?:40|50|60|80|100)_/i.test(item.url));

  const preferred = imageRows.filter((item) =>
    normalizeBrand(item.alt).includes(normalizeBrand(brand)) || normalizeBrand(item.alt).includes(normalizeBrand(title).slice(0, 12)),
  );
  const imagePool = preferred.length >= 3 ? preferred : imageRows;
  const uniqueImages = [...new Map(imagePool.map((item) => [item.url, item])).values()].slice(0, 5);
  const media: CrawledMedia[] = uniqueImages.map((item, index) => ({
    type: "image",
    url: item.url,
    position: index + 1,
    alt: item.alt || title,
  }));

  const uniqueVideos = [...new Map((raw.videos as Array<{ url: string; alt: string }>).map((item) => [item.url, item])).values()].slice(0, 1);
  uniqueVideos.forEach((item, index) => media.push({
    type: "video",
    url: item.url,
    position: media.length + index + 1,
    alt: item.alt || title,
  }));

  const pricing = calculatePricing({
    supplierPrice,
    supplierOldPrice: compareAtPrice,
    currency: String(raw.currency || "EUR"),
    eurRate,
    plnRate,
    compareAtEnabled: true,
  });

  return {
    handle,
    source: config.source,
    gender: config.gender,
    categoryId: config.id,
    category: config.category,
    sourceUrl: url,
    productCode,
    title,
    brand,
    descriptionHtml: `<p>${String(raw.description || "").trim()}</p>`,
    color: String(raw.color || "").trim() || null,
    composition: String(raw.composition || "").trim() || null,
    currency: String(raw.currency || "EUR"),
    supplierPrice,
    compareAtPrice,
    costPriceUah: pricing.costPriceUah,
    salePriceUah: pricing.salePriceUah,
    compareAtPriceUah: pricing.compareAtPriceUah,
    tags: [
      config.source === "NET_A_PORTER" ? "NET-A-PORTER" : "MR PORTER",
      config.gender === "WOMEN" ? "Women" : "Men",
      config.category,
      brand,
      "Imported by ParserVo",
    ],
    variants,
    media,
    payload: {
      sourceTitle: raw.title,
      sizeRows: raw.sizeRows,
      bodySample: raw.bodySample,
    },
  };
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function crawlCategory(context: BrowserContext, config: CrawlCategory) {
  const runId = await startCrawlRun({ categoryId: config.id, source: config.source, pages: config.pages });
  const seenHandles: string[] = [];
  let parsed = 0;
  let failed = 0;

  try {
    const links = await collectLinks(context, config, runId);
    await updateCrawlRun(runId, {
      status: "PARSING_PRODUCTS",
      links_found: links.length,
      message: `Parsing ${links.length} unique links`,
    });

    await mapConcurrent(links, concurrency, async (link, index) => {
      const page = await context.newPage();
      try {
        const product = await parsePage(page, link, config);
        await upsertProduct(product);
        seenHandles.push(product.handle);
        parsed += 1;
        console.log(`[${config.id}] ${parsed}/${links.length} ${product.brand} ${product.title}`);
      } catch (error) {
        failed += 1;
        console.error(`[${config.id}] failed ${link}`, error);
      } finally {
        await page.close();
      }

      if ((index + 1) % 10 === 0 || index + 1 === links.length) {
        await updateCrawlRun(runId, {
          products_parsed: parsed,
          products_failed: failed,
          message: `Processed ${index + 1}/${links.length}`,
        });
      }
    });

    await markMissingProducts(config.id, seenHandles);
    await updateCrawlRun(runId, {
      status: failed ? "PARTIAL" : "COMPLETED",
      products_parsed: parsed,
      products_failed: failed,
      finished_at: new Date().toISOString(),
      message: `Finished: parsed ${parsed}; failed ${failed}; expected ${config.expected}`,
    });
  } catch (error) {
    await updateCrawlRun(runId, {
      status: "ERROR",
      products_parsed: parsed,
      products_failed: failed,
      finished_at: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Unknown crawler error",
    });
    throw error;
  }
}

async function main() {
  const selected = selectCategories(process.env.CRAWL_CATEGORY || process.argv[2] || "all");
  if (!selected.length) throw new Error("No crawl categories selected.");

  const headless = String(process.env.CRAWL_HEADLESS ?? "true").toLowerCase() !== "false";
  const channel = process.env.CRAWL_BROWSER_CHANNEL?.trim();
  const proxyServer = process.env.CRAWL_PROXY_SERVER?.trim();
  const browser = await chromium.launch({
    headless,
    ...(channel ? { channel } : {}),
    ...(proxyServer ? {
      proxy: {
        server: proxyServer,
        username: process.env.CRAWL_PROXY_USERNAME,
        password: process.env.CRAWL_PROXY_PASSWORD,
      },
    } : {}),
  });
  const context = await browser.newContext({
    locale: "en-GB",
    viewport: { width: 1440, height: 1200 },
    extraHTTPHeaders: {
      "Accept-Language": "en-GB,en;q=0.9",
    },
  });

  try {
    for (const config of selected) {
      await crawlCategory(context, config);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
