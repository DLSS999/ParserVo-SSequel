import { chromium, type Page } from "playwright";
import type { MarketplaceParser, ParserProduct, ParserRunOptions, ParserVariant } from "../core/types";
import { parseMoney, slug, uniq } from "../core/utils";

const DEFAULT_CATALOG = "https://www.stoneisland.com/en-gb/men/sales/view-all-sales";

async function dismiss(page: Page) {
  for (const label of ["Accept all", "Accept All", "Allow all", "Continue", "Close"]) {
    try { const b = page.getByRole("button", { name: label, exact: false }).first(); if (await b.isVisible({ timeout: 400 })) await b.click(); } catch {}
  }
}

async function goto(page: Page, url: string) {
  let last: unknown;
  for (let i=1;i<=3;i++) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      await dismiss(page); return;
    } catch (e) { last=e; await page.waitForTimeout(1200*i); }
  }
  throw last;
}

function normalizeUrl(value: string, base = DEFAULT_CATALOG) {
  try {
    const u = new URL(value, base); u.hash=""; u.search="";
    if (!/stoneisland\.com$/i.test(u.hostname)) return null;
    return u.toString();
  } catch { return null; }
}

function normalizeSize(value: string) {
  const clean=value.replace(/^size\s*/i,"").replace(/\s+/g," ").trim();
  if (!clean || clean.length>30) return null;
  if (/^(one size|os)$/i.test(clean)) return "ONE SIZE";
  return clean.toUpperCase();
}

function productCodeFrom(title: string, url: string) {
  const fromTitle=title.match(/^([A-Z0-9]{6,12})\b/i)?.[1];
  const fromUrl=new URL(url).pathname.match(/([A-Z0-9]{6,12})(?:[\/_-]|$)/i)?.[1];
  return (fromTitle || fromUrl || slug(title).slice(0,32)).toUpperCase();
}

export class StoneIslandParser implements MarketplaceParser {
  readonly source = "STONE_ISLAND" as const;

  async collectProductUrls(options: ParserRunOptions) {
    const browser=await chromium.launch({ headless: options.headless });
    const page=await browser.newPage({ locale:"en-GB", viewport:{ width:1440,height:1000 } });
    const urls=new Set<string>();
    try {
      await goto(page, options.catalogUrl || DEFAULT_CATALOG);
      for (let pageNo=1;pageNo<=80;pageNo++) {
        await page.waitForTimeout(1500);
        const links=await page.locator('a[href]').evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href));
        for (const raw of links) {
          const url=normalizeUrl(raw, page.url());
          if (url && /\/product\//i.test(new URL(url).pathname)) urls.add(url);
        }
        const next=page.getByRole("link", { name: String(pageNo+1), exact:true }).first();
        if (!(await next.count()) || !(await next.isVisible().catch(()=>false))) break;
        await Promise.all([next.click(), page.waitForTimeout(1300)]);
      }
      return [...urls];
    } finally { await browser.close(); }
  }

  async parseProduct(url: string, options: ParserRunOptions): Promise<ParserProduct> {
    const browser=await chromium.launch({ headless: options.headless });
    const page=await browser.newPage({ locale:"en-GB", viewport:{ width:1440,height:1000 } });
    try {
      await goto(page,url); await page.waitForTimeout(1200);
      const data=await page.evaluate(() => {
        const text=(selector:string)=>document.querySelector(selector)?.textContent?.replace(/\s+/g," ").trim()||"";
        const allText=(selector:string)=>Array.from(document.querySelectorAll(selector)).map(n=>n.textContent?.replace(/\s+/g," ").trim()||"").filter(Boolean);
        const scripts=Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s=>{try{return JSON.parse(s.textContent||"")}catch{return null}}).filter(Boolean);
        const productJson=scripts.flatMap((v:any)=>Array.isArray(v)?v:[v]).find((v:any)=>v?.['@type']==='Product') as any;
        const images=Array.from(document.images).map(i=>i.currentSrc||i.src).filter(Boolean);
        const buttons=Array.from(document.querySelectorAll('button,[role="button"],option')).map((n:any)=>({
          text:(n.textContent||n.value||"").replace(/\s+/g," ").trim(), disabled:Boolean(n.disabled)||n.getAttribute('aria-disabled')==='true'
        }));
        return {
          title: text('h1') || productJson?.name || document.title,
          body: document.body.innerText,
          description: productJson?.description || text('[data-testid*="description"], [class*="description"]'),
          images: [...images, ...(Array.isArray(productJson?.image)?productJson.image:[productJson?.image].filter(Boolean))],
          price: productJson?.offers?.price,
          currency: productJson?.offers?.priceCurrency,
          sku: productJson?.sku,
          color: productJson?.color || text('[data-testid*="color"], [class*="color"]'),
          buttons,
          headings: allText('h2,h3'),
          html: document.documentElement.outerHTML,
        };
      });
      const title=data.title.replace(/\s*\|.*$/,'').trim();
      const code=productCodeFrom(title,url);
      const body=data.body;
      const currentMatch=body.match(/current price\s*£\s*([\d,.]+)/i) || body.match(/£\s*([\d,.]+)/);
      const originalMatch=body.match(/Original price\s*£\s*([\d,.]+)/i);
      const price=parseMoney(data.price || currentMatch?.[1]);
      const compareAt=parseMoney(originalMatch?.[1]);
      const color=(data.color || title.match(/\b(Black|White|Blue|Green|Grey|Gray|Red|Pink|Beige|Brown|Yellow|Ivory)\b/i)?.[1] || '').trim();
      const variants: ParserVariant[]=[];
      for (const item of data.buttons) {
        const size=normalizeSize(item.text);
        if (!size || !/^(?:[XSML]{1,4}|\d{1,3}(?:\.5)?|ONE SIZE|XXS|XXXL|2XL|3XL)$/i.test(size)) continue;
        if (variants.some(v=>v.size===size)) continue;
        variants.push({ size, sku:`${code}-${size.replace(/\s+/g,'-')}`, quantity:item.disabled?0:5, available:!item.disabled, position:variants.length+1 });
      }
      if (!variants.length && /bag|hat|cap|accessor/i.test(`${title} ${body.slice(0,1000)}`)) variants.push({size:'ONE SIZE',sku:`${code}-OS`,quantity:5,available:true,position:1});
      const media=uniq(data.images.filter((v:string)=>/^https?:\/\//i.test(v) && /stoneisland|moncler/i.test(v)))
        .slice(0,12).map((image:string,index:number)=>({type:'image' as const,url:image,position:index+1,alt:title}));
      const description=data.description || body.split('\n').map(v=>v.trim()).find(v=>v.length>40 && v.length<500 && !/price|shipping|cookie/i.test(v)) || '';
      return {
        handle: slug(`stone-island-${code}-${color || 'default'}`), source:this.source, gender:'MEN', category:'Stone Island Sale',
        brand:'Stone Island', title, sourceUrl:url, supplierProductId:data.sku || code, price,
        compareAtPrice: compareAt>price?compareAt:null, currency:data.currency || 'GBP', color:color||null,
        description, descriptionHtml: description?`<p>${description.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))}</p>`:null,
        composition:null, variants, media, tags:['Stone Island','Sale','Men'], raw:{ headings:data.headings }
      };
    } finally { await browser.close(); }
  }
}
