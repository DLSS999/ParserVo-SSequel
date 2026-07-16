import type { ParsedMarketplaceProduct } from "./media.server";
import { getCorrectProductMapping } from "./product-field-fixes.server";


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

type CategoryTarget = {
  key: string;
  type: string;
  labels: string[];
};

function normalize(value: string | null | undefined) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яіїєґ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function productText(product: ParsedMarketplaceProduct) {
  return normalize([
    product.title,
    product.description,
    product.descriptionHtml,
    product.composition,
    product.productType,
    product.productCategory,
    product.category,
    product.tags?.join(" "),
  ].filter(Boolean).join(" "));
}

function colorLabel(value: string | null | undefined) {
  const source = normalize(value);
  if (!source) return "";

  const rules: Array<[RegExp, string]> = [
    [/rose gold|рожеве золото|розовое золото/, "Rose gold"],
    [/silver|metallic silver|сріб|серебр/, "Silver"],
    [/bronze|бронз/, "Bronze"],
    [/gold|золот/, "Gold"],
    [/navy|navy blue|dark blue|midnight blue|marine|ink|темно син|темно-син/, "Navy"],
    [/black|nero|noir|чорн|черн/, "Black"],
    [/gray|grey|anthracite|charcoal|graphite|pewter|сір|сер(ый|ая|ое)/, "Gray"],
    [/brown|umber|chocolate|cocoa|coffee|mocha|mahogany|tobacco|tan|taupe|корич|каштан/, "Brown"],
    [/beige|cream|ecru|ivory|sand|oat|natural|camel|champagne|vanilla|milk|беж|крем|молоч|пісоч|песоч/, "Beige"],
    [/white|optic white|snow|chalk|bianco|білий|белый/, "White"],
    [/blue|cobalt|azure|sky|denim|блакит|син(ій|ий)/, "Blue"],
    [/green|olive|khaki|sage|mint|forest|lime|зел|олив|хакі|хаки/, "Green"],
    [/red|burgundy|bordeaux|wine|crimson|scarlet|червон|красн|бордов/, "Red"],
    [/purple|violet|lilac|lavender|фіолет|фиолет|лілов|лилов/, "Purple"],
    [/pink|rose|blush|fuchsia|рожев|розов|пудров/, "Pink"],
    [/orange|rust|coral|tangerine|помаранч|оранж/, "Orange"],
    [/yellow|lemon|mustard|жовт|желт|гірчич|горчич/, "Yellow"],
    [/clear|transparent|прозор/, "Clear"],
  ];

  for (const [pattern, label] of rules) {
    if (pattern.test(source)) return label;
  }
  return "";
}

function targetGenderLabel(product: ParsedMarketplaceProduct) {
  const source = `${product.gender || ""} ${product.tags?.join(" ") || ""}`;
  if (/women|woman|female|womens|жін|жен/i.test(source)) return "Female";
  if (/men|man|male|mens|чолов|муж/i.test(source)) return "Male";
  return "";
}

function ageGroupLabel(product: ParsedMarketplaceProduct) {
  const source = productText(product);
  if (/newborn|infant|baby|немовля|младен/.test(source)) return "Baby";
  if (/kids?|children|child|junior|дитяч|детск/.test(source)) return "Kids";
  return "Adult";
}

function sizeLabels(product: ParsedMarketplaceProduct) {
  const source = product.variants?.length
    ? product.variants.filter((variant) => variant.available !== false && Number(variant.quantity ?? 1) > 0).map((variant) => variant.size)
    : product.sizes || [];

  return unique(source.map((value) => {
    const size = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
    const map: Record<string, string> = {
      "2XS": "XXS",
      "3XS": "XXXS",
      "2XL": "XXL",
      "3XL": "XXXL",
      OS: "One size",
      "ONE SIZE": "One size",
    };
    return map[size] || size;
  }));
}

function fabricLabels(product: ParsedMarketplaceProduct) {
  const source = productText(product);
  const rules: Array<[RegExp, string]> = [
    [/organic cotton|cotton|бавовн|хлопок/, "Cotton"],
    [/cashmere|кашемір|кашемир/, "Cashmere"],
    [/merino|wool|вовн|шерст/, "Wool"],
    [/linen|льон|лен/, "Linen"],
    [/silk|шовк|шелк/, "Silk"],
    [/suede|замш/, "Suede"],
    [/leather|шкір|кож/, "Leather"],
    [/denim|джинс/, "Denim"],
    [/polyester|поліестер|полиэстер/, "Polyester"],
    [/polyamide|nylon|поліамід|полиамид|нейлон/, "Nylon"],
    [/viscose|rayon|віскоз|вискоз/, "Viscose"],
    [/elastane|spandex|еластан/, "Elastane"],
  ];
  return unique(rules.filter(([pattern]) => pattern.test(source)).map(([, label]) => label));
}

function necklineLabel(product: ParsedMarketplaceProduct) {
  const source = productText(product);
  if (/crewneck|crew neck|round neck|кругл(ий|ый) виріз|кругл(ый|ой) вырез/.test(source)) return "Crew neck";
  if (/v neck|v-neck|v образ|v-подіб/.test(source)) return "V-neck";
  if (/turtleneck|roll neck|high neck|водолаз/.test(source)) return "Turtleneck";
  if (/boat neck|batea[u]? neck|човник|лодочк/.test(source)) return "Boat neck";
  if (/scoop neck/.test(source)) return "Scoop neck";
  return "";
}

function sleeveLengthLabel(product: ParsedMarketplaceProduct) {
  const source = productText(product);
  const kind = getCorrectProductMapping(product).kind;
  if (/sleeveless|без рукав/.test(source)) return "Sleeveless";
  if (/short sleeve|коротк.{0,8}рукав/.test(source)) return "Short sleeve";
  if (/three quarter|3\/4 sleeve|три чверті|три четверти/.test(source)) return "Three-quarter sleeve";
  if (/long sleeve|довг.{0,8}рукав|длинн.{0,8}рукав/.test(source)) return "Long sleeve";
  if (["sweatshirt", "hoodie", "zip_hoodie", "sweater", "cardigan", "turtleneck", "longsleeve", "jacket", "coat", "down_jacket"].includes(kind)) {
    return "Long sleeve";
  }
  if (["tshirt", "polo"].includes(kind)) return "Short sleeve";
  return "";
}

function topLengthLabel(product: ParsedMarketplaceProduct) {
  const source = productText(product);
  const kind = getCorrectProductMapping(product).kind;
  if (/cropped|crop top|укороч|вкороч/.test(source)) return "Cropped";
  if (/longline|long length|подовжен|удлинен/.test(source)) return "Long";
  if (["sweatshirt", "hoodie", "zip_hoodie", "sweater", "cardigan", "turtleneck", "longsleeve", "tshirt", "polo", "shirt", "top"].includes(kind)) {
    return "Regular";
  }
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
    if (label === "Navy") values.add("Navy blue");
  }
  if (key === "age-group" && label === "Adult") ["Adults", "Adult"].forEach((value) => values.add(value));
  if (key === "neckline" && label === "Crew neck") ["Crewneck", "Crew neck", "Round neck"].forEach((value) => values.add(value));
  if (key === "sleeve-length-type") {
    if (label === "Long sleeve") ["Long sleeves", "Long-sleeve", "Long sleeve"].forEach((value) => values.add(value));
    if (label === "Short sleeve") ["Short sleeves", "Short-sleeve", "Short sleeve"].forEach((value) => values.add(value));
  }
  if (key === "top-length-type") {
    if (label === "Regular") ["Regular length", "Standard", "Standard length"].forEach((value) => values.add(value));
    if (label === "Long") ["Long length", "Longline"].forEach((value) => values.add(value));
  }
  if (key === "size") {
    if (label === "XXXL") values.add("3XL");
    if (label === "XXL") values.add("2XL");
    if (label === "One size") ["OS", "One Size", "One size fits all"].forEach((value) => values.add(value));
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

async function findStandardMetaobjects(
  admin: AdminClient,
  type: string,
  key: string,
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

  const ids: string[] = [];
  for (const label of unique(labels)) {
    const candidates = aliases(key, label).map(normalize);
    const node = data.metaobjects.nodes.find((entry) => {
      const values = [
        entry.displayName,
        entry.handle,
        ...(entry.fields || []).map((field) => field.value),
      ].map(normalize);
      return values.some((value) => candidates.includes(value));
    });
    if (node?.id && !ids.includes(node.id)) ids.push(node.id);
  }
  return ids;
}

export async function setNativeCategoryMetafields(
  admin: AdminClient,
  productId: string,
  product: ParsedMarketplaceProduct,
) {
  const targets: CategoryTarget[] = [
    { key: "color-pattern", type: "shopify--color-pattern", labels: [colorLabel(product.color)] },
    { key: "size", type: "shopify--size", labels: sizeLabels(product) },
    { key: "fabric", type: "shopify--fabric", labels: fabricLabels(product) },
    { key: "age-group", type: "shopify--age-group", labels: [ageGroupLabel(product)] },
    { key: "neckline", type: "shopify--neckline", labels: [necklineLabel(product)] },
    { key: "sleeve-length-type", type: "shopify--sleeve-length-type", labels: [sleeveLengthLabel(product)] },
    { key: "target-gender", type: "shopify--target-gender", labels: [targetGenderLabel(product)] },
    { key: "top-length-type", type: "shopify--top-length-type", labels: [topLengthLabel(product)] },
  ].map((target) => ({ ...target, labels: unique(target.labels) })).filter((target) => target.labels.length);

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

    let referenceIds: string[] = [];
    try {
      referenceIds = await findStandardMetaobjects(admin, target.type, target.key, target.labels);
    } catch (error) {
      errors.push(`${target.key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!referenceIds.length) {
      errors.push(`${target.key}: standard values ${target.labels.join(", ")} were not found`);
      continue;
    }

    const typeName = definition.typeName || "list.metaobject_reference";
    metafields.push({
      ownerId: productId,
      namespace: "shopify",
      key: target.key,
      type: typeName,
      value: typeName.startsWith("list.") ? JSON.stringify(referenceIds) : referenceIds[0],
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
  return colorLabel(product.color);
}
