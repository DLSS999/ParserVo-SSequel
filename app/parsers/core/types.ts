export type ParserSource = "NET_A_PORTER" | "MR_PORTER" | "STONE_ISLAND";
export type ParserGender = "WOMEN" | "MEN" | "UNISEX";

export type ParserMedia = {
  type: "image" | "video";
  url: string;
  position: number;
  alt?: string | null;
};

export type ParserVariant = {
  size: string;
  sku?: string | null;
  ean?: string | null;
  quantity: number;
  available: boolean;
  position: number;
};

export type ParserProduct = {
  handle: string;
  source: ParserSource;
  gender: ParserGender;
  category: string;
  brand: string;
  title: string;
  sourceUrl: string;
  supplierProductId: string;
  price: number;
  compareAtPrice?: number | null;
  currency: string;
  color?: string | null;
  description?: string | null;
  descriptionHtml?: string | null;
  composition?: string | null;
  variants: ParserVariant[];
  media: ParserMedia[];
  tags: string[];
  raw?: unknown;
};

export type ParserRunOptions = {
  catalogUrl: string;
  maxProducts: number;
  concurrency: number;
  headless: boolean;
  outputDir: string;
};

export interface MarketplaceParser {
  readonly source: ParserSource;
  collectProductUrls(options: ParserRunOptions): Promise<string[]>;
  parseProduct(url: string, options: ParserRunOptions): Promise<ParserProduct>;
}
