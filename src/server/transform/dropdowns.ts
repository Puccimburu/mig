import { isBlank } from "./read";
import { colToNum, parseRef, type Sheet, type Workbook } from "./workbook";

/**
 * Read the list validations on a sheet and return column → allowed options.
 * Supports inline lists ("a,b,c") and ranges ('Sheet'!$A$1:$A$10), in both the
 * classic <dataValidations> block and the x14 extension list.
 */
export function readDropdowns(wb: Workbook, sheet: Sheet): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const all = sheet.partInfo.doc.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const dv = all.item(i)!;
    if (dv.localName !== "dataValidation" || dv.getAttribute("type") !== "list") continue;
    let sqref = dv.getAttribute("sqref") ?? "";
    let formula = "";
    for (let c = dv.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const el = c as unknown as { localName: string; textContent: string | null };
      if (el.localName === "sqref") sqref = el.textContent ?? sqref;
      if (el.localName === "formula1") formula = (el.textContent ?? "").trim();
    }
    const options = resolveListFormula(wb, formula);
    if (!options) continue;
    for (const range of sqref.split(/\s+/).filter(Boolean)) {
      const [start, end = start] = range.split(":");
      const from = colToNum(start!.replace(/[$\d]/g, ""));
      const to = colToNum(end!.replace(/[$\d]/g, ""));
      for (let col = from; col <= to; col++) out.set(col, options);
    }
  }
  return out;
}

function resolveListFormula(wb: Workbook, formula: string): string[] | null {
  const f = formula.replace(/^=/, "");
  if (f.startsWith('"')) {
    return f
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?$/.exec(f);
  if (!m) return null;
  const sheetName = m[1] ? m[1].replace(/''/g, "'") : m[2]!;
  if (!wb.hasSheet(sheetName)) return null;
  const start = parseRef(m[3]!);
  const end = parseRef(m[4] ?? m[3]!);
  if (!start || !end) return null;
  const source = wb.sheet(sheetName);
  const options: string[] = [];
  for (let col = start.col; col <= end.col; col++) {
    for (let row = start.row; row <= end.row; row++) {
      const v = source.get(col, row);
      if (!isBlank(v)) options.push(String(v));
    }
  }
  return options;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

const words = (s: string) =>
  new Set(
    squash(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

/** The single candidate, or undefined when there are none or several (ambiguous). */
function unique(candidates: string[]): string | undefined {
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * Closest allowed option for a value that is not an exact match. Tries, in order:
 * case/whitespace, singular/plural, whole-word containment ("United States" →
 * "United States of America"), then edit distance. Returns undefined when nothing is
 * close enough or when several options are equally close.
 */
export function suggestOption(value: string, options: string[]): string | undefined {
  const v = squash(value);
  if (!v) return undefined;
  const same = unique(options.filter((o) => squash(o) === v));
  if (same) return same;
  const plural = unique(options.filter((o) => squash(o) === `${v}s` || `${squash(o)}s` === v));
  if (plural) return plural;
  const vw = words(value);
  const contains = (a: Set<string>, b: Set<string>) => [...b].every((w) => a.has(w));
  const subset = unique(
    options.filter((o) => {
      const ow = words(o);
      return vw.size > 0 && ow.size > 0 && (contains(ow, vw) || contains(vw, ow));
    }),
  );
  if (subset) return subset;
  let best: string[] = [];
  let bestDist = Infinity;
  for (const o of options) {
    const d = levenshtein(v, squash(o));
    if (d < bestDist) {
      bestDist = d;
      best = [o];
    } else if (d === bestDist) best.push(o);
  }
  return bestDist <= Math.max(2, Math.floor(v.length * 0.3)) ? unique(best) : undefined;
}
