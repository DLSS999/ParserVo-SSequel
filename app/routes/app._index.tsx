import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Button, DataTable, Badge, Text, Banner, BlockStack, InlineStack } from "@shopify/polaris";
import { calculatePricing, sortSizesForShopify } from "../services/pricing.server";
import { splitMedia } from "../services/media.server";
import { buildShopifyImportDraft } from "../services/shopify-import-legacy.server";
import { getSampleParsedProducts } from "../services/sample-products.server";

const categories = [
  { id: "nap-clothing", source: "NET-A-PORTER / Women", category: "Clothing", pages: 7, expectedResults: 700, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "nap-shoes", source: "NET-A-PORTER / Women", category: "Shoes", pages: 3, expectedResults: 299, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "nap-bags", source: "NET-A-PORTER / Women", category: "Bags", pages: 2, expectedResults: 146, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "nap-accessories", source: "NET-A-PORTER / Women", category: "Accessories", pages: 3, expectedResults: 137, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "mrp-clothing", source: "MR PORTER / Men", category: "Clothing", pages: 10, expectedResults: 910, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "mrp-shoes", source: "MR PORTER / Men", category: "Shoes", pages: 3, expectedResults: 282, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "mrp-bags", source: "MR PORTER / Men", category: "Bags", pages: 1, expectedResults: 37, collectedResults: 0, status: "READY_FOR_TEST" },
  { id: "mrp-accessories", source: "MR PORTER / Men", category: "Accessories", pages: 2, expectedResults: 156, collectedResults: 0, status: "READY_FOR_TEST" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  const samples = getSampleParsedProducts().map((product) => {
    const media = splitMedia(product.media);
    const draft = buildShopifyImportDraft(product);
    const pricing = calculatePricing({ supplierPrice: product.price || 0, supplierOldPrice: product.compareAtPrice || null, currency: product.currency, eurRate: 45, plnRate: 12.5, compareAtEnabled: true });
    return {
      source: product.source === "NET_A_PORTER" ? "NET-A-PORTER / Women" : "MR PORTER / Men",
      brand: product.brand,
      title: product.title,
      category: product.category,
      sizes: sortSizesForShopify(product.sizes).join(", "),
      media: `${media.images.length} фото / ${media.videos.length} видео`,
      price: `${product.currency} ${product.price}`,
      shopifyPrice: `${pricing.salePriceUah} UAH`,
      variants: draft.variants.length,
      status: "DRAFT_READY",
    };
  });

  return json({ categories, samples });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const categoryId = String(form.get("categoryId"));
  return json({ ok: true, message: `Test action received for ${categoryId}. Legacy pricing/media/shopify draft modules are connected. Production DB and real parser are next.` });
}

export default function AppIndex() {
  const { categories, samples } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const rows = categories.map((c) => [
    c.source,
    c.category,
    String(c.pages),
    String(c.expectedResults),
    String(c.collectedResults),
    <Badge key={`${c.id}-status`}>{c.status}</Badge>,
    <Form method="post" key={c.id}>
      <input type="hidden" name="categoryId" value={c.id} />
      <Button submit>Start Parsing</Button>
    </Form>,
  ]);

  const sampleRows = samples.map((p) => [
    p.source,
    p.brand,
    p.title,
    p.category,
    p.sizes,
    p.media,
    p.price,
    p.shopifyPrice,
    String(p.variants),
    <Badge key={`${p.brand}-${p.title}`}>{p.status}</Badge>,
  ]);

  return (
    <Page title="ParserVo Import App">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.message ? <Banner tone="info">{actionData.message}</Banner> : null}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Marketplace Import Dashboard</Text>
                  <Badge tone="success">Legacy modules connected</Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd">NET-A-PORTER = Women. MR PORTER = Men. First production screen is connected.</Text>
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "text", "text"]}
                  headings={["Source", "Category", "Pages", "Expected", "Collected", "Status", "Action"]}
                  rows={rows}
                />
              </BlockStack>
            </Card>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Product Preview Structure</Text>
                <Text as="p" variant="bodyMd">This preview uses copied ParserVo pricing, size sorting and Shopify draft logic. New product structure supports photos and videos.</Text>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text", "numeric", "text"]}
                  headings={["Source", "Brand", "Title", "Category", "Sizes", "Media", "Supplier", "Shopify", "Variants", "Status"]}
                  rows={sampleRows}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
