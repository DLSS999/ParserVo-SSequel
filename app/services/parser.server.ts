import { prisma } from "../db.server";
import { netAPorterAdapter } from "../adapters/netaporter";
import { mrPorterAdapter } from "../adapters/mrporter";
import { JobStatus, SourceName } from "@prisma/client";

function getAdapter(source: SourceName) { return source === SourceName.NET_A_PORTER ? netAPorterAdapter : mrPorterAdapter; }

export async function parseCategory(categoryId: string) {
  const category = await prisma.sourceCategory.findUniqueOrThrow({ where: { id: categoryId } });
  await prisma.sourceCategory.update({ where:{id: categoryId}, data:{status: JobStatus.PARSING_CATEGORY_PAGES, lastRunAt: new Date()} });
  const adapter = getAdapter(category.source);
  const links = await adapter.collectProductLinks(category as any);
  const uniqueLinks = [...new Set(links)];
  await prisma.sourceCategory.update({ where:{id: categoryId}, data:{ collectedResults: uniqueLinks.length, status: uniqueLinks.length < category.expectedResults ? JobStatus.PARTIAL : JobStatus.PARSING_PRODUCT_PAGES } });
  for (const url of uniqueLinks) {
    try {
      const parsed = await adapter.parseProduct(url, category as any);
      await prisma.product.upsert({ where:{ sourceUrl: url }, update:{ ...parsed as any, categorySourceId: category.id }, create:{ ...parsed as any, categorySourceId: category.id } });
    } catch (e) { console.error('product parse error', url, e); }
  }
  await prisma.sourceCategory.update({ where:{id: categoryId}, data:{status: JobStatus.READY_FOR_PREVIEW} });
}
