import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Card, DataTable, Badge } from "@shopify/polaris";
import { prisma } from "../db.server";
export async function loader({ request }: LoaderFunctionArgs) { const products = await prisma.product.findMany({ take: 100, orderBy:{createdAt:'desc'} }); return json({ products }); }
export default function Products(){ const {products}=useLoaderData<typeof loader>(); return <Page title="Product Preview"><Card><DataTable columnContentTypes={["text","text","text","numeric","text"]} headings={["Source","Brand","Title","Price","Status"]} rows={products.map((p:any)=>[p.source,p.brand||'',p.title,p.price||'',<Badge key={p.id}>{p.importStatus}</Badge>])}/></Card></Page>}
