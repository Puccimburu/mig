import type { MappingEntry } from "@/lib/transform/types";
import { FUZZY_EXCLUDED, RESERVED_TEMPLATE_COLUMNS } from "@/lib/transform/types";
import { looseHeader, normalizeHeader, readTable } from "./read";
import { Workbook } from "./workbook";

export type MappingPair = { client: string; template: string };

/** Parse a CSV string (RFC 4180 quoting). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Read a 2-column mapping file (CSV or XLSX): Client Column → Template Column. */
export async function parseMappingFile(name: string, data: Uint8Array): Promise<MappingPair[]> {
  let rows: string[][];
  if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) {
    rows = parseCsv(new TextDecoder().decode(data));
  } else {
    const wb = await Workbook.load(data);
    const sheet = wb.sheet(wb.sheetNames[0]!);
    rows = sheet.rowNumbers().map((r) => {
      const values = sheet.rowValues(r);
      const max = Math.max(0, ...values.keys());
      return Array.from({ length: max }, (_, i) => String(values.get(i + 1) ?? ""));
    });
  }
  if (!rows.length) return [];
  let clientIdx = 0;
  let templateIdx = 1;
  const head = rows[0]!.map((c) => c.toLowerCase());
  const ci = head.findIndex((c) => c.includes("client"));
  const ti = head.findIndex((c) => c.includes("template"));
  if (ci >= 0 && ti >= 0) {
    clientIdx = ci;
    templateIdx = ti;
    rows = rows.slice(1);
  }
  return rows
    .map((r) => ({ client: (r[clientIdx] ?? "").trim(), template: (r[templateIdx] ?? "").trim() }))
    .filter((p) => p.client && p.template);
}

/** Other wordings clients use for template columns (compared loosely, numbering ignored). */
const SYNONYMS: Record<string, string[]> = {
  "party name": ["counterparty name", "counterparty", "counter party name", "vendor name"],
  "address line 1": ["street 1", "street", "street address", "address 1", "address"],
  "address line 2": ["street 2", "address 2"],
  country: ["counterparty country", "party country"],
  state: ["counterparty state", "province"],
  city: ["counterparty city"],
  "zip code": ["postal code", "zip", "postcode"],
  "effective date": ["start date", "commencement date"],
  "expiration date": ["expiry date", "end date", "termination date"],
  "legal party": ["legal party configured", "legal entity"],
  description: ["contract description", "title"],
};

/** Client header that is a known synonym of the template header, e.g. "Street 1" → "Address Line 1". */
function synonymMatch(template: string, clientHeaders: string[]): string | undefined {
  const names = SYNONYMS[looseHeader(template)];
  if (!names) return undefined;
  // "Counterparty Name 1" should match "counterparty name": drop a trailing number.
  const key = (h: string) => looseHeader(h).replace(/\s+\d+$/, "");
  for (const name of names) {
    const hit =
      clientHeaders.find((h) => looseHeader(h) === name) ??
      clientHeaders.find((h) => key(h) === name);
    if (hit) return hit;
  }
  return undefined;
}

/** Fuzzy matching is on for every dropdown except the excluded columns (e.g. Party Name). */
export function defaultFuzzy(template: string): boolean {
  return !FUZZY_EXCLUDED.some((h) => looseHeader(h) === looseHeader(template));
}

/**
 * Propose a mapping for every template column. Priority: mapping file, exact header
 * match, then alias match (custom-field suffix / parenthetical notes stripped).
 */
export function autoMap(
  templateHeaders: string[],
  clientHeaders: string[],
  opts: { dropdownHeaders: Set<string>; mandatory: string[]; pairs?: MappingPair[] },
): { entries: MappingEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const byNorm = new Map<string, string>();
  for (const h of clientHeaders)
    if (!byNorm.has(normalizeHeader(h))) byNorm.set(normalizeHeader(h), h);
  const mandatory = new Set(opts.mandatory.map(looseHeader));
  const reserved = new Set(RESERVED_TEMPLATE_COLUMNS.map(normalizeHeader));
  const fromFile = new Map<string, string>();
  for (const p of opts.pairs ?? []) {
    const client = byNorm.get(normalizeHeader(p.client));
    if (!client) {
      warnings.push(
        `Mapping file: client column "${p.client}" was not found in Metadata Extraction.`,
      );
      continue;
    }
    if (!templateHeaders.some((t) => normalizeHeader(t) === normalizeHeader(p.template))) {
      warnings.push(
        `Mapping file: template column "${p.template}" was not found in Contract Request.`,
      );
      continue;
    }
    fromFile.set(normalizeHeader(p.template), client);
  }

  const entries = templateHeaders.map((template): MappingEntry => {
    const dropdown = opts.dropdownHeaders.has(template);
    const base = {
      template,
      mandatory: mandatory.has(looseHeader(template)),
      dropdown,
      fuzzy: dropdown && defaultFuzzy(template),
    };
    if (reserved.has(normalizeHeader(template)))
      return { ...base, client: null, source: "none", reserved: true };
    const file = fromFile.get(normalizeHeader(template));
    if (file) return { ...base, client: file, source: "file", reserved: false };
    const exact = byNorm.get(normalizeHeader(template));
    if (exact) return { ...base, client: exact, source: "exact", reserved: false };
    const alias =
      clientHeaders.find((h) => looseHeader(h) === looseHeader(template)) ??
      synonymMatch(template, clientHeaders);
    if (alias) return { ...base, client: alias, source: "alias", reserved: false };
    return { ...base, client: null, source: "none", reserved: false };
  });
  return { entries, warnings };
}

/** Headers of the first table in a workbook sheet (helper for tests and analysis). */
export function sheetHeaders(wb: Workbook, sheetName: string): string[] {
  return readTable(wb.sheet(sheetName)).headers.map((h) => h.text);
}
