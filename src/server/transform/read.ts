import type { CellValue, Sheet, Workbook } from "./workbook";

/** Lowercase, trim and collapse whitespace: "File Paths " → "file paths". */
export function normalizeHeader(h: string): string {
  return h.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Split CamelCase: "TerminalLocation" → "Terminal Location". */
export function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/**
 * Loose header key used for alias matching:
 * - "Application Type Custom Fields(TerminalLocation)" → "terminal location"
 * - "Assignee (Only 1 Email ID)" → "assignee"
 * - "Is final signed copy?" → "is final signed copy"
 */
export function looseHeader(h: string): string {
  const custom = /^application type custom fields\s*\((.+)\)\s*$/i.exec(h.trim());
  const base = custom ? splitCamel(custom[1]!) : h.replace(/\([^)]*\)/g, " ");
  return normalizeHeader(base.replace(/[^\p{L}\p{N}]+/gu, " "));
}

export type Header = { col: number; text: string };

export type Table = {
  sheet: Sheet;
  headerRow: number;
  headers: Header[];
  /** Rows below the header that contain at least one value. */
  dataRows: number[];
};

/** Find the header row (the row with the most text cells among the first rows) and the data rows. */
export function readTable(sheet: Sheet, scanRows = 10): Table {
  const rows = sheet.rowNumbers();
  let headerRow = rows[0] ?? 1;
  let best = -1;
  for (const r of rows.slice(0, scanRows)) {
    const textCells = [...sheet.rowValues(r).values()].filter((v) => typeof v === "string").length;
    if (textCells > best) {
      best = textCells;
      headerRow = r;
    }
  }
  const headers: Header[] = [...sheet.rowValues(headerRow)]
    .filter(([, v]) => typeof v === "string" && v.trim() !== "")
    .map(([col, v]) => ({ col, text: String(v) }))
    .sort((a, b) => a.col - b.col);
  const dataRows = rows.filter((r) => r > headerRow && sheet.rowValues(r).size > 0);
  return { sheet, headerRow, headers, dataRows };
}

/** Column of the first header matching any candidate: exact (normalized) first, then loose. */
export function findColumn(table: Table, ...candidates: string[]): number | null {
  for (const c of candidates) {
    const hit = table.headers.find((h) => normalizeHeader(h.text) === normalizeHeader(c));
    if (hit) return hit.col;
  }
  for (const c of candidates) {
    const hit = table.headers.find((h) => looseHeader(h.text) === looseHeader(c));
    if (hit) return hit.col;
  }
  return null;
}

/** Find a sheet by name (loose), falling back to the first sheet whose headers satisfy `test`. */
export function findSheet(
  wb: Workbook,
  names: string[],
  test?: (t: Table) => boolean,
): string | null {
  const byName = wb.sheetNames.find((n) => names.some((c) => looseHeader(n) === looseHeader(c)));
  if (byName) return byName;
  if (!test) return null;
  for (const name of wb.sheetNames) {
    try {
      if (test(readTable(wb.sheet(name)))) return name;
    } catch {
      // Unreadable sheets (chartsheets, etc.) are skipped.
    }
  }
  return null;
}

export function isBlank(v: CellValue): boolean {
  return v === null || (typeof v === "string" && v.trim() === "");
}

/** Excel serial date → yyyy-mm-dd. */
export function excelSerialToIso(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial + 1e-9) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isDateHeader(header: string): boolean {
  return /\bdate\b|\bsigned on\b/i.test(header);
}
