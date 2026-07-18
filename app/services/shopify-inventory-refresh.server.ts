import type { ParsedMarketplaceProduct, ParsedMarketplaceVariant } from "./media.server";
import {
  databaseAdminHeaders,
  databaseAdminRequest,
} from "./browser-capture.server";

type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type UserError = { field?: string[] | string | null; message: string; code?: string | null };

type ShopifyVariant = {
  id: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  inventoryItem: { id: string; tracked: boolean } | null;
};

function handleFor(product: ParsedMarketplaceProduct) {
  const raw = product.handle || product.supplierProductId || product.title;
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

function normalizeSize(value: string | null | undefined) {
  const clean = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  return /^(DEFAULT TITLE|ONE SIZE|OS|UN)$/.test(clean) ? "DEFAULT TITLE" : clean;
}

async function graphql<T>(admin: AdminClient, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (!response.ok) throw new Error(`Shopify API HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  if (body.errors?.length) {
    throw new Error(body.errors.map((error: { message?: string }) => error.message || "GraphQL error").join(" | "));
  }
  return body.data as T;
}

function throwUserErrors(context: string, errors?: UserError[]) {
  if (!errors?.length) return;
  throw new Error(`${context}: ${errors.map((error) => error.message).join(" | ")}`);
}

async function resolveLocation(admin: AdminClient) {
  const data = await graphql<{ locations: { nodes: Array<{ id: string; name: string; isActive?: boolean }> } }>(
    admin,
    `#graphql
      query ParserVoInventoryLocations {
        locations(first: 20) { nodes { id name isActive } }
      }
    `,
    {},
  );
  return data.locations.nodes.find((location) => location.isActive !== false) || data.locations.nodes[0] || null;
}

function capturedQuantity(variant: ParsedMarketplaceVariant | undefined) {
  if (!variant || variant.available === false) return 0;
  const quantity = Number(variant.quantity || 0);
  return Number.isFinite(quantity) ? Math.max(0, Math.trunc(quantity)) : 0;
}

function selectedSize(variant: ShopifyVariant) {
  const row = variant.selectedOptions.find((option) => /^(розмір|size|title)$/i.test(option.name));
  return normalizeSize(row?.value || "");
}

async function updateStoredInventory(product: ParsedMarketplaceProduct, quantities: Map<string, number>) {
  const handle = handleFor(product);
  const existing = await databaseAdminRequest(
    `parservo_variants?product_handle=eq.${encodeURIComponent(handle)}&select=*`,
  ) as Array<Record<string, any>>;

  const capturedBySize = new Map(
    (product.variants || []).map((variant) => [normalizeSize(variant.size), variant]),
  );
  const now = new Date().toISOString();
  const merged = (Array.isArray(existing) ? existing : []).map((row, index) => {
    const size = normalizeSize(String(row.size || ""));
    const captured = capturedBySize.get(size);
    const quantity = quantities.has(size)
      ? Number(quantities.get(size) || 0)
      : capturedQuantity(captured);
    return {
      product_handle: handle,
      size: row.size || (size === "DEFAULT TITLE" ? "Default Title" : size),
      sku: row.sku || captured?.sku || product.supplierProductId || handle,
      inventory_qty: quantity,
      price_uah: row.price_uah ?? captured?.salePriceUah ?? product.pricing?.salePriceUah ?? 0,
      compare_at_price_uah: row.compare_at_price_uah ?? captured?.compareAtPriceUah ?? product.pricing?.compareAtPriceUah ?? null,
      cost_uah: row.cost_uah ?? captured?.costPriceUah ?? product.pricing?.costPriceUah ?? 0,
      available: quantity > 0,
      position: Number(row.position || index + 1),
      supplier_status: quantity === 0 ? "SOLD_OUT" : quantity === 1 ? "LOW_STOCK" : "IN_STOCK",
      last_seen_at: now,
    };
  });

  for (const variant of product.variants || []) {
    const size = normalizeSize(variant.size);
    if (merged.some((row) => normalizeSize(String(row.size)) === size)) continue;
    const quantity = capturedQuantity(variant);
    merged.push({
      product_handle: handle,
      size: size === "DEFAULT TITLE" ? "Default Title" : variant.size,
      sku: variant.sku || product.supplierProductId || handle,
      inventory_qty: quantity,
      price_uah: variant.salePriceUah ?? product.pricing?.salePriceUah ?? 0,
      compare_at_price_uah: variant.compareAtPriceUah ?? product.pricing?.compareAtPriceUah ?? null,
      cost_uah: variant.costPriceUah ?? product.pricing?.costPriceUah ?? 0,
      available: quantity > 0,
      position: merged.length + 1,
      supplier_status: quantity === 0 ? "SOLD_OUT" : quantity === 1 ? "LOW_STOCK" : "IN_STOCK",
      last_seen_at: now,
    });
  }

  await databaseAdminRequest(`parservo_variants?product_handle=eq.${encodeURIComponent(handle)}`, {
    method: "DELETE",
  });
  if (merged.length) {
    await databaseAdminRequest("parservo_variants", {
      method: "POST",
      headers: databaseAdminHeaders("return=minimal"),
      body: JSON.stringify(merged),
    });
  }

  const total = merged.reduce((sum, row) => sum + Number(row.inventory_qty || 0), 0);
  await databaseAdminRequest(`parservo_products?handle=eq.${encodeURIComponent(handle)}`, {
    method: "PATCH",
    headers: databaseAdminHeaders("return=minimal"),
    body: JSON.stringify({
      status: total > 0 ? "active" : "draft",
      import_status: total > 0 ? "IMPORTED" : "OUT_OF_STOCK",
      last_seen_at: now,
      updated_at: now,
      last_error: null,
    }),
  });
}

export async function syncStoneIslandInventoryOnly(
  admin: AdminClient,
  product: ParsedMarketplaceProduct,
) {
  const handle = handleFor(product);
  const data = await graphql<{
    products: {
      nodes: Array<{
        id: string;
        title: string;
        variants: { nodes: ShopifyVariant[] };
      }>;
    };
  }>(
    admin,
    `#graphql
      query ParserVoInventoryProduct($query: String!) {
        products(first: 1, query: $query) {
          nodes {
            id
            title
            variants(first: 100) {
              nodes {
                id
                sku
                selectedOptions { name value }
                inventoryItem { id tracked }
              }
            }
          }
        }
      }
    `,
    { query: `handle:${handle}` },
  );

  const shopifyProduct = data.products.nodes[0];
  if (!shopifyProduct) throw new Error(`Товар ${handle} не найден в Shopify для обновления наличия.`);
  const location = await resolveLocation(admin);
  if (!location) throw new Error("В Shopify не найдена активная локация для обновления остатков.");

  const captured = product.variants || [];
  const bySize = new Map(captured.map((variant) => [normalizeSize(variant.size), variant]));
  const defaultVariant = captured.length === 1 && normalizeSize(captured[0].size) === "DEFAULT TITLE";
  const storedQuantities = new Map<string, number>();
  const quantities = shopifyProduct.variants.nodes
    .filter((variant) => variant.inventoryItem?.id)
    .map((variant) => {
      const size = selectedSize(variant);
      const match = bySize.get(size) || (defaultVariant ? captured[0] : undefined);
      const quantity = capturedQuantity(match);
      storedQuantities.set(size || "DEFAULT TITLE", quantity);
      return {
        inventoryItemId: variant.inventoryItem!.id,
        locationId: location.id,
        quantity,
      };
    });

  if (!quantities.length) throw new Error(`У товара ${shopifyProduct.title} не найдены отслеживаемые варианты.`);

  const mutation = await graphql<{
    inventorySetQuantities: {
      userErrors: UserError[];
      inventoryAdjustmentGroup?: { createdAt?: string | null } | null;
    };
  }>(
    admin,
    `#graphql
      mutation ParserVoSetInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          inventoryAdjustmentGroup { createdAt }
          userErrors { code field message }
        }
      }
    `,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities,
      },
    },
  );
  throwUserErrors("Shopify inventory update failed", mutation.inventorySetQuantities.userErrors);
  await updateStoredInventory(product, storedQuantities);

  const totalQuantity = [...storedQuantities.values()].reduce((sum, quantity) => sum + quantity, 0);
  return {
    productId: shopifyProduct.id,
    title: shopifyProduct.title,
    updatedVariants: quantities.length,
    totalQuantity,
    inStockVariants: [...storedQuantities.values()].filter((quantity) => quantity > 0).length,
  };
}
