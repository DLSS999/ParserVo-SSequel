export function statusBadgeClass(status: string | null | undefined) {
  if (!status) return "badge";

  if ([
    "active",
    "supplier_available",
    "imported",
    "shopify_product_created",
    "shopify_inventory_synced",
    "browser_captured",
  ].includes(status)) return "badge badge-green";

  if ([
    "shopify_draft",
    "drafted_by_sync",
    "supplier_sold_out",
    "manual_disabled",
    "sync_queued",
    "duplicate",
  ].includes(status)) return "badge badge-yellow";

  if ([
    "sync_error",
    "shopify_product_create_error",
    "shopify_inventory_sync_error",
    "stock_capture_error",
  ].includes(status)) return "badge badge-red";

  return "badge";
}
