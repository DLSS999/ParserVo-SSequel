import { chromium } from "playwright";
import type { MarketplaceAdapter, SourceCategoryConfig, ParsedProduct } from "./types";

export class YnapAdapter implements MarketplaceAdapter {
  constructor(private source: "NET_A_PORTER" | "MR_PORTER") {}

  async collectProductLinks(config: SourceCategoryConfig): Promise<string[]> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: "en-GB" });
    const links = new Set<string>();
    try {
      for (let p = 1; p <= config.pages; p++) {
        const url = config.url + (config.url.includes("?") ? "&" : "?") + `pageNumber=${p}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1500);
        const hrefs = await page.$$eval('a[href*="/product/"]', as => as.map(a => (a as HTMLAnchorElement).href));
        hrefs.forEach(h => links.add(h.split("?")[0]));
      }
      return [...links];
    } finally { await browser.close(); }
  }

  async parseProduct(url: string, config: SourceCategoryConfig): Promise<ParsedProduct> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ locale: "en-GB" });
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
      const data = await page.evaluate(() => {
        const text = (sel:string) => document.querySelector(sel)?.textContent?.trim() || undefined;
        const meta = (name:string) => document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.getAttribute("content") || undefined;
        const imgs = [...document.querySelectorAll('img')].map(i => (i as HTMLImageElement).src).filter(Boolean).filter(src => src.includes('ynap-content.com') || src.includes('mrporter') || src.includes('net-a-porter'));
        const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent || "");
        let ld:any = {};
        for (const s of scripts) { try { const j = JSON.parse(s); if (j['@type']==='Product' || j.name) ld = j; } catch {} }
        return {
          title: ld.name || meta('og:title') || text('h1') || 'Untitled product',
          description: ld.description || meta('og:description') || '',
          brand: typeof ld.brand === 'object' ? ld.brand?.name : ld.brand,
          price: ld.offers?.price ? Number(ld.offers.price) : undefined,
          currency: ld.offers?.priceCurrency || 'EUR',
          images: [...new Set([...(Array.isArray(ld.image) ? ld.image : ld.image ? [ld.image] : []), ...imgs])]
        };
      });
      return { source: config.source, gender: config.gender, category: config.category, brand: data.brand, title: data.title, price: data.price, currency: data.currency || "EUR", description: data.description, sourceUrl: url, imageUrls: data.images || [] };
    } finally { await browser.close(); }
  }
}
