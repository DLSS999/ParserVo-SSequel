import type { ParsedMarketplaceProduct } from "./media.server";
import { getProductMapping } from "./product-mapping.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type TaxonomyCategoryNode = {
  id: string;
  fullName?: string | null;
  name?: string | null;
  isLeaf?: boolean | null;
};

function normalize(value: string | null | undefined) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastCategoryName(fullName: string) {
  return fullName.split(">").map((part) => part.trim()).filter(Boolean).pop() || fullName;
}

export async function resolveShopifyTaxonomyCategory(
  admin: AdminClient,
  product: ParsedMarketplaceProduct,
) {
  const fullName = getProductMapping(product).taxonomyPath;
  const search = lastCategoryName(fullName);

  try {
    const response = await admin.graphql(
      `#graphql
        query ParserVoTaxonomyCategory($search: String!) {
          taxonomy {
            categories(first: 50, search: $search) {
              nodes {
                id
                name
                fullName
                isLeaf
              }
            }
          }
        }
      `,
      { variables: { search } },
    );
    const json = await response.json();
    if (!response.ok) throw new Error(`Shopify taxonomy HTTP ${response.status}`);
    if (json.errors?.length) {
      throw new Error(json.errors.map((error: { message?: string }) => error.message || "Taxonomy error").join(" | "));
    }

    const nodes = (json.data?.taxonomy?.categories?.nodes || []) as TaxonomyCategoryNode[];
    const exact = nodes.find((node) => normalize(node.fullName) === normalize(fullName));
    const leaf = nodes.find((node) => normalize(node.name) === normalize(search) && node.isLeaf !== false);
    const selected = exact || leaf || nodes.find((node) => node.isLeaf !== false) || nodes[0];

    return {
      id: selected?.id || null,
      requestedFullName: fullName,
      matchedFullName: selected?.fullName || null,
      error: null as string | null,
    };
  } catch (error) {
    return {
      id: null,
      requestedFullName: fullName,
      matchedFullName: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
