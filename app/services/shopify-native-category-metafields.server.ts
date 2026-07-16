import type { ParsedMarketplaceProduct } from "./media.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type UserError = {
  field?: string[] | string | null;
  message: string;
  code?: string | null;
};

type StandardDefinition = {
  ok: boolean;
  typeName: string;
  message: string;
};

function normalize(value: string | null | undefined) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яіїєґ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function colorLabel(value: string | null | undefined) {
  const source = String(value || "").toUpperCase().replace(/[\s_/-]+/g, " ").trim();
  const map: Record<string, string> = {
    BLACK: "Black", BLUE: "Blue", BROWN: "Brown", BEIGE: "Beige", CREAM: "Beige",
    IVORY: "Beige", ECRU: "Beige", GOLD: "Gold", GRAY: "Gray", GREY: "Grey",
    GREEN: "Green", NAVY: "Navy", "NAVY BLUE": "Navy", ORANGE: "Orange",
    PINK: "Pink", PURPLE: "Purple", RED: "Red", SILVER: "Silver", WHITE: "White",
    YELLOW: "Yellow", BRONZE: "Bronze", "ROSE GOLD": "Rose gold",
    ЧОРНИЙ: "Black", СИНІЙ: "Blue", БЛАКИТНИЙ: "Blue", КОРИЧНЕВИЙ: "Brown",
    БЕЖЕВИЙ: "Beige", ЗОЛОТИЙ: "Gold", СІРИЙ: "Gray", ЗЕЛЕНИЙ: "Green",
    "ТЕМНО СИНІЙ": "Navy", ПОМАРАНЧЕВИЙ: "Orange", РОЖЕВИЙ: "Pink",
    ФІОЛЕТОВИЙ: "Purple", ЧЕРВОНИЙ: "Red", СРІБЛЯСТИЙ: "Silver",
    БІЛИЙ: "White", ЖОВТИЙ: "Yellow",
  };
  return map[source] || map[source.split(" ")[0]] || "";
}

function targetGenderLabel(product: ParsedMarketplaceProduct) {
  const source = `${product.gender || ""} ${product.tags?.join(" ") || ""}`;
  if (/women|woman|female|womens|жін|жен/i.test(source)) return "Female";
  if (/men|man|male|mens|чолов|муж/i.test(source)) return "Male";
  return "";
}

function aliases(key: string, label: string) {
  const values = new Set<string>([label]);
  if (key === "target-gender") {
    if (label === "Female") ["Women", "Woman", "Womens", "Female"].forEach((value) => values.add(value));
    if (label === "Male") ["Men", "Man", "Mens", "Male"].forEach((value) => values.add(value));
  }
  if (key === "color-pattern") {
    if (label === "Gray") values.add("Grey");
    if (label === "Grey") values.add("Gray");
    if (label === "Navy") values.add("Navy blue");
  }
  return [...values];
}

async function graphql<T>(
  admin: AdminClient,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (!response.ok) throw new Error(`Shopify category metafield HTTP ${response.status}`);
  if (json.errors?.length) {
    throw new Error(json.errors.map((error: { message?: string }) => error.message || "GraphQL error").join(" | "));
  }
  return json.data as T;
}

async function ensureDefinition(admin: AdminClient, key: string): Promise<StandardDefinition> {
  const namespace = "shopify";
  const fallbackType = "list.metaobject_reference";

  try {
    const existing = await graphql<{
      metafieldDefinition: {
        id: string;
        type?: { name?: string | null } | null;
      } | null;
    }>(
      admin,
      `#graphql
        query ParserVoCategoryMetafieldDefinition($identifier: MetafieldDefinitionIdentifierInput!) {
          metafieldDefinition(identifier: $identifier) {
            id
            type { name }
          }
        }
      `,
      { identifier: { ownerType: "PRODUCT", namespace, key } },
    );

    if (existing.metafieldDefinition?.id) {
      return {
        ok: true,
        typeName: existing.metafieldDefinition.type?.name || fallbackType,
        message: "enabled",
      };
    }
  } catch {
    // Continue with enable mutation.
  }

  try {
    const enabled = await graphql<{
      standardMetafieldDefinitionEnable: {
        createdDefinition?: {
          id: string;
          type?: { name?: string | null } | null;
        } | null;
        userErrors?: UserError[];
      };
    }>(
      admin,
      `#graphql
        mutation ParserVoEnableCategoryMetafield($namespace: String!, $key: String!) {
          standardMetafieldDefinitionEnable(
            ownerType: PRODUCT,
            namespace: $namespace,
            key: $key,
            pin: false
          ) {
            createdDefinition { id type { name } }
            userErrors { code field message }
          }
        }
      `,
      { namespace, key },
    );

    const created = enabled.standardMetafieldDefinitionEnable.createdDefinition;
    if (created?.id) {
      return { ok: true, typeName: created.type?.name || fallbackType, message: "created" };
    }

    const errors = enabled.standardMetafieldDefinitionEnable.userErrors || [];
    if (errors.some((error) => /already|exist|taken|enabled/i.test(error.message))) {
      return ensureDefinition(admin, key);
    }
    return {
      ok: false,
      typeName: fallbackType,
      message: errors.map((error) => error.message).join(" | ") || "definition not available",
    };
  } catch (error) {
    return {
      ok: false,
      typeName: fallbackType,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function findStandardMetaobject(
  admin: AdminClient,
  type: string,
  labels: string[],
) {
  const data = await graphql<{
    metaobjects: {
      nodes: Array<{
        id: string;
        displayName?: string | null;
        handle?: string | null;
        fields?: Array<{ key: string; value?: string | null }>;
      }>;
    };
  }>(
    admin,
    `#graphql
      query ParserVoFindStandardCategoryValues($type: String!) {
        metaobjects(type: $type, first: 250) {
          nodes {
            id
            displayName
            handle
            fields { key value }
          }
        }
      }
    `,
    { type },
  );

  const candidates = unique(labels).map(normalize);
  const node = data.metaobjects.nodes.find((entry) => {
    const values = [
      entry.displayName,
      entry.handle,
      ...(entry.fields || []).map((field) => field.value),
    ].map(normalize);
    return values.some((value) => candidates.includes(value));
  });
  return node?.id || "";
}

export async function setNativeCategoryMetafields(
  admin: AdminClient,
  productId: string,
  product: ParsedMarketplaceProduct,
) {
  const targets = [
    {
      key: "color-pattern",
      type: "shopify--color-pattern",
      label: colorLabel(product.color),
    },
    {
      key: "target-gender",
      type: "shopify--target-gender",
      label: targetGenderLabel(product),
    },
  ].filter((target) => target.label);

  const errors: string[] = [];
  const metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];

  for (const target of targets) {
    const definition = await ensureDefinition(admin, target.key);
    if (!definition.ok) {
      errors.push(`${target.key}: ${definition.message}`);
      continue;
    }

    let referenceId = "";
    try {
      referenceId = await findStandardMetaobject(
        admin,
        target.type,
        aliases(target.key, target.label),
      );
    } catch (error) {
      errors.push(`${target.key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!referenceId) {
      errors.push(`${target.key}: standard value ${target.label} was not found`);
      continue;
    }

    const typeName = definition.typeName || "list.metaobject_reference";
    metafields.push({
      ownerId: productId,
      namespace: "shopify",
      key: target.key,
      type: typeName,
      value: typeName.startsWith("list.") ? JSON.stringify([referenceId]) : referenceId,
    });
  }

  if (!metafields.length) return { synced: 0, errors };

  const result = await graphql<{
    metafieldsSet: {
      metafields?: Array<{ id: string }>;
      userErrors?: UserError[];
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoSetNativeCategoryMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { code field message }
        }
      }
    `,
    { metafields },
  );

  errors.push(...(result.metafieldsSet.userErrors || []).map((error) => error.message));
  return {
    synced: result.metafieldsSet.metafields?.length || 0,
    errors,
  };
}

export function getTargetGenderValue(product: ParsedMarketplaceProduct) {
  return targetGenderLabel(product);
}

export function getColorValue(product: ParsedMarketplaceProduct) {
  return colorLabel(product.color) || String(product.color || "").trim();
}
