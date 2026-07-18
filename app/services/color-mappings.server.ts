const DEFAULT_SUPABASE_URL = "https://cuzjuykyelzrvxxbcjry.supabase.co";

export const STANDARD_COLORS = [
  "Silver",
  "Red",
  "Purple",
  "Pink",
  "Green",
  "Gray",
  "Blue",
  "Black",
  "Beige",
  "Brown",
  "Navy",
  "White",
  "Bronze",
  "Clear",
  "Gold",
  "Orange",
  "Rose gold",
  "Yellow",
] as const;

export type StandardColor = (typeof STANDARD_COLORS)[number];

export type ColorMapping = {
  source_color: string;
  standard_color: string;
  enabled: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type DiscoveredColor = {
  sourceColor: string;
  standardColor: string;
  exactRule: boolean;
};

const STANDARD_COLOR_SET = new Set<string>(STANDARD_COLORS);
let cache: { expiresAt: number; mappings: ColorMapping[] } | null = null;

function config() {
  const url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY;
  return { url, key };
}

function requestHeaders(key: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    apikey: key,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  if (!key) throw new Error("Supabase API key is not configured.");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: requestHeaders(key, (init.headers || {}) as Record<string, string>),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase color mappings ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

export function cleanSupplierColor(value: string | null | undefined) {
  return String(value || "")
    .replace(/^colou?r\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSupplierColor(value: string | null | undefined) {
  return cleanSupplierColor(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9а-яіїєґ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fallbackStandardColor(value: string | null | undefined): string {
  const source = normalizeSupplierColor(value);
  if (!source) return "";

  const rules: Array<[RegExp, StandardColor]> = [
    [/rose gold|рожеве золото|розовое золото/, "Rose gold"],
    [/silver|metallic silver|сріб|серебр/, "Silver"],
    [/bronze|бронз/, "Bronze"],
    [/gold|золот/, "Gold"],
    [/navy|navy blue|dark blue|midnight blue|marine|ink|темно син|темно-син/, "Navy"],
    [/black|nero|noir|чорн|черн/, "Black"],
    [/gray|grey|anthracite|charcoal|graphite|pewter|сір|сер(ый|ая|ое)/, "Gray"],
    [/brown|umber|chocolate|cocoa|coffee|mocha|mahogany|tobacco|tan|taupe|корич|каштан/, "Brown"],
    [/beige|cream|ecru|ivory|sand|oat|natural|camel|champagne|vanilla|milk|desert|беж|крем|молоч|пісоч|песоч/, "Beige"],
    [/white|optic white|snow|chalk|bianco|білий|белый/, "White"],
    [/blue|cobalt|azure|sky|denim|avio|блакит|син(ій|ий)/, "Blue"],
    [/green|olive|khaki|sage|mint|forest|lime|malachite|military green|зел|олив|хакі|хаки/, "Green"],
    [/red|burgundy|bordeaux|wine|crimson|scarlet|brick|червон|красн|бордов/, "Red"],
    [/purple|violet|lilac|lavender|фіолет|фиолет|лілов|лилов/, "Purple"],
    [/pink|rose|blush|fuchsia|oleander|рожев|розов|пудров/, "Pink"],
    [/orange|rust|coral|tangerine|mustard|помаранч|оранж|гірчич|горчич/, "Orange"],
    [/yellow|lemon|жовт|желт/, "Yellow"],
    [/clear|transparent|прозор/, "Clear"],
  ];

  for (const [pattern, label] of rules) {
    if (pattern.test(source)) return label;
  }
  return "";
}

export async function loadColorMappings(force = false): Promise<ColorMapping[]> {
  if (!force && cache && cache.expiresAt > Date.now()) return cache.mappings;
  const rows = await rest("parservo_color_mappings?select=source_color,standard_color,enabled,created_at,updated_at&order=source_color.asc");
  const mappings = Array.isArray(rows) ? rows as ColorMapping[] : [];
  cache = { expiresAt: Date.now() + 30_000, mappings };
  return mappings;
}

export async function resolveStandardColor(value: string | null | undefined) {
  const normalized = normalizeSupplierColor(value);
  if (!normalized) return "";

  try {
    const mappings = await loadColorMappings();
    const exact = mappings.find((mapping) => (
      mapping.enabled !== false
      && normalizeSupplierColor(mapping.source_color) === normalized
      && STANDARD_COLOR_SET.has(mapping.standard_color)
    ));
    if (exact) return exact.standard_color;
  } catch {
    // Keep imports working with fallback rules if Supabase is temporarily unavailable.
  }

  return fallbackStandardColor(value);
}

export async function upsertColorMapping(sourceColor: string, standardColor: string, enabled = true) {
  const source = cleanSupplierColor(sourceColor);
  if (!source) throw new Error("Укажите исходное название цвета.");
  if (!STANDARD_COLOR_SET.has(standardColor)) throw new Error("Выбран недопустимый стандартный цвет.");

  await rest("parservo_color_mappings?on_conflict=source_color", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      source_color: source,
      standard_color: standardColor,
      enabled,
      updated_at: new Date().toISOString(),
    }]),
  });
  cache = null;
}

export async function deleteColorMapping(sourceColor: string) {
  const source = cleanSupplierColor(sourceColor);
  if (!source) return;
  await rest(`parservo_color_mappings?source_color=eq.${encodeURIComponent(source)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  cache = null;
}

export async function loadDiscoveredColors(): Promise<DiscoveredColor[]> {
  const [mappings, productRows] = await Promise.all([
    loadColorMappings(),
    rest("parservo_products?source=eq.STONE_ISLAND&color=not.is.null&select=color&order=color.asc"),
  ]);

  const exactByNormalized = new Map(
    mappings
      .filter((mapping) => mapping.enabled !== false)
      .map((mapping) => [normalizeSupplierColor(mapping.source_color), mapping.standard_color]),
  );

  const seen = new Map<string, string>();
  for (const row of Array.isArray(productRows) ? productRows : []) {
    const sourceColor = cleanSupplierColor(row?.color);
    const normalized = normalizeSupplierColor(sourceColor);
    if (sourceColor && normalized && !seen.has(normalized)) seen.set(normalized, sourceColor);
  }

  return [...seen.entries()]
    .map(([normalized, sourceColor]) => ({
      sourceColor,
      standardColor: exactByNormalized.get(normalized) || fallbackStandardColor(sourceColor),
      exactRule: exactByNormalized.has(normalized),
    }))
    .sort((left, right) => left.sourceColor.localeCompare(right.sourceColor));
}
