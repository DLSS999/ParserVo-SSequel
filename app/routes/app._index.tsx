import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Button, DataTable, Badge, Text } from "@shopify/polaris";
import { prisma } from "../db.server";
import { seedSources } from "../services/seedSources.server";
import { parseCategory } from "../services/parser.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await seedSources();
  const categories = await prisma.sourceCategory.findMany({ orderBy: [{ source: "asc" }, { category: "asc" }] });
  return json({ categories });
}
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const categoryId = String(form.get("categoryId"));
  // MVP: direct run. Production: move to BullMQ worker.
  parseCategory(categoryId).catch(console.error);
  return json({ ok: true });
}
export default function AppIndex() {
  const { categories } = useLoaderData<typeof loader>();
  const rows = categories.map((c:any) => [c.source === 'NET_A_PORTER' ? 'NET-A-PORTER / Women' : 'MR PORTER / Men', c.category, String(c.pages), String(c.expectedResults), String(c.collectedResults), <Badge key={c.id}>{c.status}</Badge>, <Form method="post" key={c.id}><input type="hidden" name="categoryId" value={c.id}/><Button submit>Start Parsing</Button></Form>]);
  return <Page title="ParserVo Import App"><Layout><Layout.Section><Card><Text as="h2" variant="headingMd">Marketplace Import Dashboard</Text><DataTable columnContentTypes={["text","text","numeric","numeric","numeric","text","text"]} headings={["Source","Category","Pages","Expected","Collected","Status","Action"]} rows={rows}/></Card></Layout.Section></Layout></Page>;
}
