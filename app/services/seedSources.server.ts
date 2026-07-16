import { prisma } from "../db.server";
import { Gender, SourceName } from "@prisma/client";

export async function seedSources() {
  const rows = [
    { source: SourceName.NET_A_PORTER, gender: Gender.WOMEN, category: "Clothing", pages: 7, expectedResults: 700, url: "https://www.net-a-porter.com/en-pl/shop/clothing?facet=ads_f10003_ntk_cs%253A%2522AMI%2BPARIS%2522&facet=ads_f10003_ntk_cs%253A%2522BALENCIAGA%2522&facet=ads_f10003_ntk_cs%253A%2522BRUNELLO%2BCUCINELLI%2522&facet=ads_f10003_ntk_cs%253A%2522JACQUEMUS%2522&facet=ads_f10003_ntk_cs%253A%2522JIL%2BSANDER%2522&facet=ads_f10003_ntk_cs%253A%2522ON%2522&facet=ads_f10003_ntk_cs%253A%2522LORO%2BPIANA%2522&facet=ads_f10003_ntk_cs%253A%2522ACNE%2BSTUDIOS%2522&facet=ads_f10003_ntk_cs%253A%2522THE%2BROW%2522&facet=ads_f10003_ntk_cs%253A%2522TOTEME%2522&facet=price_EUR_4000000000000001121%253A%2528%257B1000%2B2000%257D%2B2000%2529&facet=price_EUR_4000000000000001121%253A%2528%257B500%2B1000%257D%2B1000%2529&facet=price_EUR_4000000000000001121%253A%2528%257B250%2B500%257D%2B500%2529&facet=price_EUR_4000000000000001121%253A%2528%257B%2A%2B250%257D%2B250%2529" },
    { source: SourceName.NET_A_PORTER, gender: Gender.WOMEN, category: "Shoes", pages: 3, expectedResults: 299, url: "https://www.net-a-porter.com/en-pl/shop/shoes" },
    { source: SourceName.NET_A_PORTER, gender: Gender.WOMEN, category: "Bags", pages: 2, expectedResults: 146, url: "https://www.net-a-porter.com/en-pl/shop/bags" },
    { source: SourceName.NET_A_PORTER, gender: Gender.WOMEN, category: "Accessories", pages: 3, expectedResults: 137, url: "https://www.net-a-porter.com/en-pl/shop/accessories" },
    { source: SourceName.MR_PORTER, gender: Gender.MEN, category: "Clothing", pages: 10, expectedResults: 910, url: "https://www.mrporter.com/en-pl/mens/clothing" },
    { source: SourceName.MR_PORTER, gender: Gender.MEN, category: "Shoes", pages: 3, expectedResults: 282, url: "https://www.mrporter.com/en-pl/mens/shoes" },
    { source: SourceName.MR_PORTER, gender: Gender.MEN, category: "Bags", pages: 1, expectedResults: 37, url: "https://www.mrporter.com/en-pl/mens/accessories/bags" },
    { source: SourceName.MR_PORTER, gender: Gender.MEN, category: "Accessories", pages: 2, expectedResults: 156, url: "https://www.mrporter.com/en-pl/mens/accessories" }
  ];
  for (const row of rows) {
    await prisma.sourceCategory.upsert({ where: { id: `${row.source}-${row.category}` }, create: { id: `${row.source}-${row.category}`, ...row }, update: row });
  }
}
