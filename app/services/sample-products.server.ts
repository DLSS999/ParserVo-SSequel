import type { ParsedMarketplaceProduct } from "./media.server";

function media(urls: string[]) {
  return urls.map((url, index) => ({ type: "image" as const, url, position: index + 1 }));
}

export function getSampleParsedProducts(_appUrl?: string): ParsedMarketplaceProduct[] {
  return [
    {
      handle: "acne-studios-printed-organic-cotton-blend-jersey-hoodie",
      source: "NET_A_PORTER",
      gender: "WOMEN",
      category: "Clothing",
      productCategory: "Apparel & Accessories > Clothing > Activewear > Activewear Sweatshirts & Hoodies > Hoodies",
      productType: "Худі",
      brand: "ACNE STUDIOS",
      title: "ACNE STUDIOS Printed organic cotton-blend jersey hoodie",
      sourceUrl: "https://www.net-a-porter.com/en-pl/shop/product/acne-studios/clothing/sweatshirts/printed-organic-cotton-blend-jersey-hoodie/46376663162861400",
      supplierProductId: "46376663162861400",
      price: 26460,
      currency: "UAH",
      sizes: ["L", "XL", "2XL"],
      variants: [
        { size: "L", quantity: 2, available: true, position: 1, costPriceUah: 26460, salePriceUah: 31460 },
        { size: "XL", quantity: 2, available: true, position: 2, costPriceUah: 26460, salePriceUah: 31460 },
        { size: "2XL", quantity: 2, available: true, position: 3, costPriceUah: 26460, salePriceUah: 31460 },
      ],
      pricing: { costPriceUah: 26460, salePriceUah: 31460, compareAtPriceUah: null },
      tags: ["net-a-porter"],
      status: "active",
      descriptionHtml: "<p>Худі Acne Studios з органічної бавовни, вільним кроєм та логотипом бренду на спині.</p>",
      media: media([
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w920_q80.avif?v=1782067734",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w920_q80_9e16c373-d8cb-456d-b5df-cccfb7286f7d.avif?v=1782067737",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w920_q80_52e235e8-cadf-4501-8066-ed99bacbfe7c.avif?v=1782067741",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w920_q80.jpg?v=1782067744"
      ]),
    },
    {
      handle: "ami-paris-logo-embroidered-cotton-jersey-t-shirt",
      source: "MR_PORTER",
      gender: "MEN",
      category: "Clothing",
      productCategory: "Apparel & Accessories > Clothing > Clothing Tops > T-Shirts",
      productType: "Футболки",
      brand: "AMI PARIS",
      title: "AMI PARIS Logo-Embroidered Cotton-Jersey T-Shirt",
      sourceUrl: "https://www.mrporter.com/en-pl/mens/product/ami-paris/clothing/plain-t-shirts/logo-embroidered-cotton-jersey-t-shirt/46376663163015926",
      supplierProductId: "46376663163015926",
      price: 9180,
      currency: "UAH",
      sizes: ["XS", "S", "M", "L", "XL"],
      variants: [
        { size: "XS", quantity: 2, available: true, position: 1, costPriceUah: 9180, salePriceUah: 14180 },
        { size: "S", quantity: 2, available: true, position: 2, costPriceUah: 9180, salePriceUah: 14180 },
        { size: "M", quantity: 2, available: true, position: 3, costPriceUah: 9180, salePriceUah: 14180 },
        { size: "L", quantity: 2, available: true, position: 4, costPriceUah: 9180, salePriceUah: 14180 },
        { size: "XL", quantity: 2, available: true, position: 5, costPriceUah: 9180, salePriceUah: 14180 },
      ],
      pricing: { costPriceUah: 9180, salePriceUah: 14180, compareAtPriceUah: null },
      tags: ["mrporter"],
      status: "active",
      descriptionHtml: "<p>Футболка AMI PARIS з бавовняного трикотажу та вишивкою Ami de Coeur.</p>",
      media: media([
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w960_q80.webp?v=1782066813",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w960_q80_96fc3109-ab2d-4975-8957-fe2ef541c587.webp?v=1782066816",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w960_q80_f3a865d1-c8b1-4a46-8bb4-2cf5c4abef90.webp?v=1782066819",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w960_q80_cacc716d-830c-49d5-93a6-a57ea8dd0208.webp?v=1782066822",
        "https://cdn.shopify.com/s/files/1/0731/5370/8214/files/w960_q80_6fff5990-15da-4367-88e6-99cd3df62e81.webp?v=1782066824"
      ]),
    },
  ];
}
