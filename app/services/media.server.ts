export type SourceMediaItem = {
  type: "image" | "video";
  url: string;
  position: number;
  alt?: string | null;
  posterUrl?: string | null;
};

export type ParsedMarketplaceProduct = {
  source: "NET_A_PORTER" | "MR_PORTER";
  gender: "WOMEN" | "MEN";
  category: string;
  brand: string;
  title: string;
  sourceUrl: string;
  supplierProductId?: string | null;
  price?: number | null;
  compareAtPrice?: number | null;
  currency: string;
  color?: string | null;
  sizes: string[];
  description?: string | null;
  composition?: string | null;
  media: SourceMediaItem[];
};

export function splitMedia(media: SourceMediaItem[]) {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  return {
    images: sorted.filter((item) => item.type === "image"),
    videos: sorted.filter((item) => item.type === "video"),
    firstImage: sorted.find((item) => item.type === "image") || null,
  };
}

export function normalizeMediaUrls(urls: Array<string | null | undefined>, type: "image" | "video" = "image") {
  const unique = Array.from(new Set(urls.map((url) => String(url || "").trim()).filter(Boolean)));
  return unique.map((url, index) => ({ type, url, position: index + 1 } satisfies SourceMediaItem));
}

export function buildMediaJson(media: SourceMediaItem[]) {
  return JSON.stringify(media.map((item) => ({
    type: item.type,
    url: item.url,
    position: item.position,
    alt: item.alt || null,
    posterUrl: item.posterUrl || null,
  })));
}
