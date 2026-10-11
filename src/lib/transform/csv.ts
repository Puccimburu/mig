import type { MappingEntry } from "./types";

export function toCsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\r\n");
}

/** Same 2-column layout the mapping-file upload accepts. */
export function mappingToCsv(entries: MappingEntry[]): string {
  return toCsv([
    ["Client Column", "Template Column"],
    ...entries.filter((e) => e.client && !e.reserved).map((e) => [e.client!, e.template]),
  ]);
}
