import type { AppTypeCount } from "@/lib/transform/types";
import { levenshtein } from "./dropdowns";
import { findSheet, isBlank, readTable } from "./read";
import type { Workbook } from "./workbook";

const MONTHS =
  "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december";
const NOISE = new RegExp(
  `^(${MONTHS}|template|templates|import|final|copy|of|draft|v\\d+|\\d+)$`,
  "i",
);

/** App type name implied by a template file name: "NDA_Aug_20.xlsx" → "NDA". */
export function templateLabel(fileName: string): string {
  const tokens = fileName
    .replace(/\.[^.]+$/, "")
    .split(/[\s_\-.()[\]]+/)
    .filter(Boolean);
  const kept = tokens.filter((t) => !NOISE.test(t));
  return (kept.length ? kept : tokens).join(" ");
}

/** Client app type → name configured on the system, from the client's "App Types" sheet. */
export function readSystemNames(wb: Workbook): Map<string, string> {
  const out = new Map<string, string>();
  const name = findSheet(wb, ["App Types"]);
  if (!name) return out;
  const table = readTable(wb.sheet(name));
  const clientCol =
    table.headers.find((h) => /provided|client/i.test(h.text))?.col ?? table.headers[0]?.col;
  const systemCol =
    table.headers.find((h) => /configured on the system|corresponding|system/i.test(h.text))?.col ??
    table.headers[1]?.col;
  if (!clientCol || !systemCol) return out;
  for (const r of table.dataRows) {
    const client = table.sheet.get(clientCol, r);
    const system = table.sheet.get(systemCol, r);
    // The sheet also holds notes further down; stop at the first incomplete row.
    if (isBlank(client) || isBlank(system)) break;
    if (String(client).includes("-->")) break;
    out.set(String(client).trim(), String(system).trim());
  }
  return out;
}

const tokensOf = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

/** 0–1 similarity between a template label and an app type name. */
export function nameSimilarity(a: string, b: string): number {
  const x = [...tokensOf(a)].join(" ");
  const y = [...tokensOf(b)].join(" ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = tokensOf(a);
  const ty = tokensOf(b);
  const inX = [...ty].every((t) => tx.has(t));
  const inY = [...tx].every((t) => ty.has(t));
  if (inX || inY) return 0.85 + 0.1 * (Math.min(tx.size, ty.size) / Math.max(tx.size, ty.size));
  const shared = [...tx].filter((t) => ty.has(t)).length;
  const jaccard = shared / new Set([...tx, ...ty]).size;
  const chars = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return 0.8 * Math.max(jaccard, chars);
}

export type TemplateMatch = { appTypes: string[]; score: number };

/** Words too generic to tie a template to an app type ("IT Agreements" ↔ "IT - Other" share "it"). */
const GENERIC = new Set([
  "agreement",
  "agreements",
  "contract",
  "contracts",
  "of",
  "the",
  "and",
  "a",
]);
const MAX_COMBINATION_TYPES = 16;

function sharesWord(label: string, name: string): boolean {
  const words = [...tokensOf(label)].filter((w) => !GENERIC.has(w));
  const other = tokensOf(name);
  return words.some((w) => other.has(w));
}

/**
 * Assign each template to the client app type(s) it belongs to.
 *
 * - Single app type: the best name match (client or system name); an equal row count
 *   adds a small bonus.
 * - Several app types: when no single type has the template's row count, combinations of
 *   types that share a meaningful word with the template name and whose row counts add
 *   up exactly to it are tried (e.g. "IT Agreements" = IT - Statement of Work + IT - Other
 *   + IT - Master Services Agreement).
 *
 * Each app type is used by one template (best scores first); weak matches (< 0.5) stay
 * unassigned.
 */
export function matchTemplates(
  templates: { label: string; rows: number }[],
  appTypes: AppTypeCount[],
): TemplateMatch[] {
  const similarity = (label: string, a: AppTypeCount) =>
    Math.max(
      ...[a.name, ...(a.systemName ? [a.systemName] : [])].map((n) => nameSimilarity(label, n)),
    );
  const candidates: { t: number; types: string[]; score: number }[] = [];
  templates.forEach((tpl, t) => {
    for (const a of appTypes) {
      const exact = tpl.rows > 0 && tpl.rows === a.count;
      candidates.push({
        t,
        types: [a.name],
        score: Math.min(1, similarity(tpl.label, a) + (exact ? 0.05 : 0)),
      });
    }
    if (tpl.rows <= 0 || appTypes.some((a) => a.count === tpl.rows)) return;
    const related = appTypes
      .filter((a) => a.count > 0 && a.count < tpl.rows)
      .filter((a) => [a.name, a.systemName ?? ""].some((n) => sharesWord(tpl.label, n)))
      .slice(0, MAX_COMBINATION_TYPES);
    for (let mask = 3; mask < 1 << related.length; mask++) {
      if ((mask & (mask - 1)) === 0) continue; // single types are handled above
      const members = related.filter((_, i) => mask & (1 << i));
      if (members.reduce((n, a) => n + a.count, 0) !== tpl.rows) continue;
      const meanSimilarity =
        members.reduce((n, a) => n + similarity(tpl.label, a), 0) / members.length;
      // An exact row total over related types is strong evidence on its own.
      candidates.push({ t, types: members.map((a) => a.name), score: 0.6 + 0.35 * meanSimilarity });
    }
  });
  candidates.sort((p, q) => q.score - p.score || q.types.length - p.types.length);
  const result: TemplateMatch[] = templates.map(() => ({ appTypes: [], score: 0 }));
  const usedTemplates = new Set<number>();
  const usedTypes = new Set<string>();
  for (const c of candidates) {
    if (c.score < 0.5 || usedTemplates.has(c.t) || c.types.some((x) => usedTypes.has(x))) continue;
    result[c.t] = { appTypes: c.types, score: Math.round(c.score * 100) / 100 };
    usedTemplates.add(c.t);
    for (const x of c.types) usedTypes.add(x);
  }
  return result;
}
