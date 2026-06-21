import type { ParsedMarketplaceProduct } from "./media.server";

const womenImages = [
  "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1539109136881-3be0616acf4b?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1551488831-00ddcb6c6bd3?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=900&q=80",
];

const menImages = [
  "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1543508282-6319a3e2621f?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1460353581641-37baddab0fa2?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1495555961986-6d4c1ecb7be3?auto=format&fit=crop&w=900&q=80",
];

function mediaFrom(urls: string[]) {
  return urls.map((url, index) => ({ type: "image" as const, url, position: index + 1 }));
}

export function getSampleParsedProducts(_appUrl?: string): ParsedMarketplaceProduct[] {
  return [
    {
      source: "NET_A_PORTER",
      gender: "WOMEN",
      category: "Clothing",
      brand: "BALENCIAGA",
      title: "Oversized cotton-jersey T-shirt",
      sourceUrl: "https://www.net-a-porter.com/",
      supplierProductId: "NAP-BAL-001",
      price: 650,
      compareAtPrice: 790,
      currency: "EUR",
      color: "Black",
      sizes: ["XS", "S", "M", "L"],
      description: "ParserVo test product. Replace with parsed NET-A-PORTER product data.",
      composition: "100% cotton",
      media: mediaFrom(womenImages),
    },
    {
      source: "MR_PORTER",
      gender: "MEN",
      category: "Shoes",
      brand: "SALOMON",
      title: "XT-6 rubber-trimmed mesh sneakers",
      sourceUrl: "https://www.mrporter.com/",
      supplierProductId: "MRP-SAL-001",
      price: 180,
      compareAtPrice: null,
      currency: "EUR",
      color: "White",
      sizes: ["41", "42", "43", "44"],
      description: "ParserVo test product. Replace with parsed MR PORTER product data.",
      composition: "Mesh, rubber, textile",
      media: mediaFrom(menImages),
    },
  ];
}
