import type { ParsedSupplierProduct, ParsedSupplierVariant } from "./vitkac.server";

function decode(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}
function text(html: string) { return decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")); }
function num(value: string | undefined) {
  if (!value) return null;
  const s=value.replace(/\s/g,"").replace(/[^0-9,.-]/g,"");
  const lastComma=s.lastIndexOf(","), lastDot=s.lastIndexOf(".");
  let n=s;
  if(lastComma>=0&&lastDot>=0){ const d=lastComma>lastDot?",":"."; const t=d===","?".":","; n=s.replaceAll(t,"").replace(d,"."); }
  else if(lastComma>=0) n=s.replace(/\./g,"").replace(",",".");
  const p=Number(n.replace(/[^0-9.-]/g,"")); return Number.isFinite(p)?p:null;
}
function unique<T>(v:T[]){return [...new Set(v)]}
function jsonLd(html:string){
  const blocks=[...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for(const b of blocks){try{const j=JSON.parse(b[1]); const list=Array.isArray(j)?j:[j]; const p=list.flatMap((x:any)=>x?.['@graph']||[x]).find((x:any)=>x?.['@type']==='Product'); if(p)return p;}catch{}}
  return null;
}
export function isStoneIslandUrl(url:string){return /stoneisland\.com/i.test(url)}
export async function parseStoneIslandProduct(url:string, providedHtml?:string):Promise<ParsedSupplierProduct>{
  const html=providedHtml || await fetch(url,{headers:{"user-agent":"Mozilla/5.0","accept-language":"en-PL,en;q=0.9"}}).then(async r=>{if(!r.ok)throw new Error(`Stone Island HTTP ${r.status}`);return r.text()});
  const ld:any=jsonLd(html)||{};
  const page=text(html);
  const title=decode(String(ld.name||html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||html.match(/<title>(.*?)<\/title>/i)?.[1]||"Stone Island product").replace(/<[^>]+>/g," ").replace(/\s+/g," "));
  const sku=String(ld.sku||ld.productID||url.match(/([A-Z0-9]{7,20})(?:[._-]|\.html)/i)?.[1]||title.match(/\b[A-Z0-9]{6,16}\b/)?.[0]||Buffer.from(url).toString('base64url').slice(0,18));
  const offers=Array.isArray(ld.offers)?ld.offers[0]:(ld.offers||{});
  const price=num(String(offers.price||page.match(/(?:zł|PLN)\s*([\d\s.,]+)/i)?.[1]||page.match(/([\d\s.,]+)\s*(?:zł|PLN)/i)?.[1]||""))||0;
  const oldCandidates=[...page.matchAll(/(?:zł|PLN)\s*([\d\s.,]+)/gi)].map(m=>num(m[1])||0).filter(Boolean);
  const oldPrice=oldCandidates.filter(v=>v>price).sort((a,b)=>b-a)[0]||null;
  const currency=String(offers.priceCurrency||(/zł|PLN/i.test(page)?"PLN":"EUR")).toUpperCase();
  const images=unique((Array.isArray(ld.image)?ld.image:[ld.image]).filter(Boolean).concat([...html.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi)].map(m=>m[0].replace(/\\\//g,"/")))).slice(0,20);
  const color=page.match(/COLOU?R\s*:?\s*([A-Za-z][A-Za-z\s-]{2,40})/i)?.[1]?.trim()||"";
  const optionMatches=[...html.matchAll(/<option[^>]*?(?:disabled)?[^>]*>([^<]{1,30})<\/option>/gi)].map(m=>m[1].trim()).filter(v=>/^(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,3}|ONE SIZE)$/i.test(v));
  const variants:ParsedSupplierVariant[]=unique(optionMatches).map(size=>({size:size.toUpperCase(),supplierSizeLabel:size,available:true}));
  if(!variants.length) variants.push({size:"ONE SIZE",supplierSizeLabel:"ONE SIZE",available:true});
  const desc=decode(String(ld.description||page.match(/Regular-fit[\s\S]{0,600}/i)?.[0]||"").replace(/<[^>]+>/g," ").replace(/\s+/g," "));
  return {supplierName:"Stone Island",supplierUrl:url.split("?")[0],supplierProductId:sku,supplierSymbol:sku,supplierCurrency:currency,supplierPrice:price,supplierOldPrice:oldPrice,brand:"STONE ISLAND",title,originalTitle:title,description:desc,originalDescription:desc,color,colorUa:color,gender:"MEN",genderUa:"Чоловічий",category:"Clothing",categoryUa:"Одяг",productType:"Stone Island",material:"",composition:"",countryOfOrigin:null,modelCode:sku,breadcrumbs:"Stone Island / Men / Sale",images,variants};
}
