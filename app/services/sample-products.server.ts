import { type ParsedMarketplaceProduct } from "./media.server";

export function getSampleParsedProducts(): ParsedMarketplaceProduct[] {
  return [
    {
      source: "NET_A_PORTER",
      gender: "WOMEN",
      category: "Clothing",
      brand: "BALENCIAGA",
      title: "Oversized cotton-jersey T-shirt",
      sourceUrl: "NET_A_PORTER_SAMPLE_PRODUCT",
      supplierProductId: "NAP-BAL-001",
      price: 650,
      compareAtPrice: 790,
      currency: "EUR",
      color: "Black",
      sizes: ["XS", "S", "M", "L"],
      description: "Sample product parsed from NET-A-PORTER. Real parser will replace this with supplier data.",
      composition: "100% cotton",
      media: [
        { type: "image", url: "IMAGE_SAMPLE_1", position: 1 },
        { type: "image", url: "IMAGE_SAMPLE_2", position: 2 },
        { type: "video", url: "VIDEO_SAMPLE_1", position: 3 },
      ],
    },
    {
      source: "MR_PORTER",
      gender: "MEN",
      category: "Shoes",
      brand: "SALOMON",
      title: "XT-6 rubber-trimmed mesh sneakers",
      sourceUrl: "MR_PORTER_SAMPLE_PRODUCT",
      supplierProductId: "MRP-SAL-001",
      price: 180,
      compareAtPrice: null,
      currency: "EUR",
      color: "White",
      sizes: ["41", "42", "43", "44"],
      description: "Sample product parsed from MR PORTER. Real parser will replace this with supplier data.",
      composition: "Mesh, rubber, textile",
      media: [{ type: "image", url: "IMAGE_SAMPLE_3", position: 1 }],
    },
  ];
}
