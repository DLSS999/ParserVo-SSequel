import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Button, DataTable, Badge, Text, Banner, BlockStack } from "@shopify/polaris";

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
  return json({ categories });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const categoryId = String(form.get("categoryId"));
  return json({ ok: true, message: `Test action received for ${categoryId}. Parser worker will be connected after production DB setup.` });
}

export default function AppIndex() {
  const { categories } = useLoaderData<typeof loader>();
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

  return (
    <Page title="ParserVo Import App">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.message ? <Banner tone="info">{actionData.message}</Banner> : null}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Marketplace Import Dashboard</Text>
                <Text as="p" variant="bodyMd">NET-A-PORTER = Women. MR PORTER = Men. First production screen is connected.</Text>
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "text", "text"]}
                  headings={["Source", "Category", "Pages", "Expected", "Collected", "Status", "Action"]}
                  rows={rows}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
