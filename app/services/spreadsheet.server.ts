import * as XLSX from "xlsx";

export type SpreadsheetRow = Record<string, string>;

function normalizeHeader(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[\-]+/g, "_")
    .replace(/[^a-z0-9_а-яіїєґ]/gi, "");
}

function normalizeCell(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export async function parseSpreadsheetFile(file: File): Promise<SpreadsheetRow[]> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("Файл пустой или не содержит листов.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  return rawRows.map((row) => {
    const normalized: SpreadsheetRow = {};

    for (const [key, value] of Object.entries(row)) {
      const normalizedKey = normalizeHeader(key);
      if (!normalizedKey) continue;
      normalized[normalizedKey] = normalizeCell(value);
    }

    return normalized;
  });
}

export function pickColumn(row: SpreadsheetRow, possibleNames: string[]) {
  for (const name of possibleNames) {
    const normalizedName = normalizeHeader(name);
    const value = row[normalizedName];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

export function parseBooleanCell(value: string) {
  const normalized = String(value || "").trim().toLowerCase();

  if (["1", "true", "yes", "y", "так", "да", "available", "in_stock", "instock", "last item", "останній", "є"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "ні", "нет", "sold_out", "out_of_stock", "unavailable", "notify", "powiadom"].includes(normalized)) {
    return false;
  }

  const numeric = Number(normalized.replace(",", "."));
  if (Number.isFinite(numeric)) return numeric > 0;

  return false;
}

export function parseNumberCell(value: string, fallback = 0) {
  const normalized = String(value || "")
    .replace(/\s+/g, "")
    .replace(",", ".")
    .replace(/[^0-9.\-]/g, "");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}
