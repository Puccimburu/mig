// Minimal OOXML (.xlsx/.xlsm) patcher. It edits workbooks in place instead of
// regenerating them: only the XML parts we change are re-serialized, every other
// zip entry (macros, drawings, tables, themes, ...) is carried over untouched.
import JSZip from "jszip";
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const WORKSHEET_TYPE = `${DOC_REL}/worksheet`;
const WORKSHEET_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
export const HIGHLIGHT_RGB = "FFFFD966";
export const CORRECTED_RGB = "FFBDD7EE";

export type CellValue = string | number | null;

// ---------- cell reference helpers ----------

export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function numToCol(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellRef(col: number, row: number): string {
  return `${numToCol(col)}${row}`;
}

export function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  if (!m) return null;
  return { col: colToNum(m[1]!), row: Number(m[2]) };
}

/** Shift every column at or past `afterCol + 1` one to the right in a ref/sqref string. */
export function shiftRefs(text: string, afterCol: number): string {
  return text
    .split(/\s+/)
    .map((token) =>
      token
        .split(":")
        .map((end) =>
          end.replace(
            /^(\$?)([A-Za-z]+)(\$?\d*)$/,
            (all, d1: string, col: string, rest: string) => {
              const n = colToNum(col);
              return n > afterCol ? `${d1}${numToCol(n + 1)}${rest}` : all;
            },
          ),
        )
        .join(":"),
    )
    .join(" ");
}

// ---------- XML helpers ----------

function parseXml(xml: string): Document {
  return new DOMParser({
    onError: (level, message) => {
      if (level === "fatalError") throw new Error(`Invalid XML: ${message}`);
    },
  }).parseFromString(xml.replace(/^\uFEFF/, ""), "text/xml"); // OpenXML SDK parts start with a BOM
}

function serializeXml(doc: Document, original: string): string {
  const out = new XMLSerializer().serializeToString(doc);
  if (out.startsWith("<?xml")) return out;
  const decl = /^<\?xml[^>]*\?>/.exec(original.trimStart());
  return decl ? `${decl[0]}${out}` : out;
}

export function childElements(node: Node | null | undefined, localName?: string): Element[] {
  const out: Element[] = [];
  if (!node) return out;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (!localName || (c as Element).localName === localName))
      out.push(c as Element);
  }
  return out;
}

function firstChild(node: Node | null | undefined, localName: string): Element | null {
  return childElements(node, localName)[0] ?? null;
}

function textOf(node: Element): string {
  // Concatenate <t> text, skipping phonetic runs (<rPh>).
  let s = "";
  for (const child of childElements(node)) {
    if (child.localName === "t") s += child.textContent ?? "";
    else if (child.localName === "r") s += textOf(child);
  }
  return s;
}

// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

class XmlPart {
  readonly doc: Document;
  readonly root: Element;
  /** Prefix used for the main namespace in this part ("x" for OpenXML SDK files, null for default). */
  readonly prefix: string | null;
  dirty = false;
  constructor(
    readonly path: string,
    readonly original: string,
    ns: string,
  ) {
    this.doc = parseXml(original);
    this.root = this.doc.documentElement!;
    this.prefix = this.root.namespaceURI === ns ? this.root.prefix : null;
  }
  el(localName: string, ns = MAIN): Element {
    return this.doc.createElementNS(ns, this.prefix ? `${this.prefix}:${localName}` : localName);
  }
  serialize(): string {
    return serializeXml(this.doc, this.original);
  }
}

function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${baseDir}/${target}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

// ---------- styles ----------

class Styles {
  private readonly cache = new Map<string, number>();
  private readonly fillIds = new Map<string, number>();
  constructor(private readonly part: XmlPart) {}

  /** Returns a cellXfs index that looks like `baseXf` plus a solid `rgb` fill. */
  highlight(baseXf: number, rgb = HIGHLIGHT_RGB): number {
    const key = `${baseXf}:${rgb}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const root = this.part.root;
    let fillId = this.fillIds.get(rgb);
    if (fillId === undefined) {
      let fills = firstChild(root, "fills");
      if (!fills) {
        fills = this.part.el("fills");
        root.insertBefore(fills, firstChild(root, "borders") ?? firstChild(root, "cellXfs"));
      }
      const fill = this.part.el("fill");
      const pattern = this.part.el("patternFill");
      pattern.setAttribute("patternType", "solid");
      const fg = this.part.el("fgColor");
      fg.setAttribute("rgb", rgb);
      const bg = this.part.el("bgColor");
      bg.setAttribute("indexed", "64");
      pattern.appendChild(fg);
      pattern.appendChild(bg);
      fill.appendChild(pattern);
      fills.appendChild(fill);
      const count = childElements(fills, "fill").length;
      fills.setAttribute("count", String(count));
      fillId = count - 1;
      this.fillIds.set(rgb, fillId);
    }
    const cellXfs = firstChild(root, "cellXfs");
    if (!cellXfs) throw new Error("styles.xml has no cellXfs");
    const xfs = childElements(cellXfs, "xf");
    const base = xfs[baseXf] ?? xfs[0];
    const xf = base ? (base.cloneNode(true) as Element) : this.part.el("xf");
    xf.setAttribute("fillId", String(fillId));
    xf.setAttribute("applyFill", "1");
    cellXfs.appendChild(xf);
    cellXfs.setAttribute("count", String(xfs.length + 1));
    this.part.dirty = true;
    this.cache.set(key, xfs.length);
    return xfs.length;
  }
}

// ---------- worksheet ----------

export class Sheet {
  private sheetData: Element;
  private rows = new Map<number, Element>();
  private cells = new Map<number, Map<number, Element>>();
  readonly warnings: string[] = [];

  constructor(
    private readonly wb: Workbook,
    readonly name: string,
    private readonly part: XmlPart,
  ) {
    let sd = firstChild(part.root, "sheetData");
    if (!sd) {
      sd = part.el("sheetData");
      part.root.appendChild(sd);
    }
    this.sheetData = sd;
    this.index();
  }

  private index() {
    this.rows.clear();
    this.cells.clear();
    let prevRow = 0;
    for (const row of childElements(this.sheetData, "row")) {
      const r = Number(row.getAttribute("r")) || prevRow + 1;
      prevRow = r;
      this.rows.set(r, row);
      const map = new Map<number, Element>();
      let prevCol = 0;
      for (const c of childElements(row, "c")) {
        const ref = c.getAttribute("r");
        const col = (ref && parseRef(ref)?.col) || prevCol + 1;
        prevCol = col;
        map.set(col, c);
      }
      this.cells.set(r, map);
    }
  }

  rowNumbers(): number[] {
    return [...this.rows.keys()].sort((a, b) => a - b);
  }

  /** Column → value for one row (empty cells omitted). */
  rowValues(row: number): Map<number, CellValue> {
    const out = new Map<number, CellValue>();
    for (const [col, c] of this.cells.get(row) ?? []) {
      const v = this.wb.cellValue(c);
      if (v !== null && v !== "") out.set(col, v);
    }
    return out;
  }

  get(col: number, row: number): CellValue {
    const c = this.cells.get(row)?.get(col);
    return c ? this.wb.cellValue(c) : null;
  }

  styleOf(col: number, row: number): number {
    return Number(this.cells.get(row)?.get(col)?.getAttribute("s") ?? 0) || 0;
  }

  hasElement(localName: string): boolean {
    return this.part.doc.getElementsByTagNameNS(MAIN, localName).length > 0;
  }

  private ensureCell(col: number, row: number): Element {
    let rowEl = this.rows.get(row);
    if (!rowEl) {
      rowEl = this.part.el("row");
      rowEl.setAttribute("r", String(row));
      const next = this.rowNumbers().find((r) => r > row);
      this.sheetData.insertBefore(rowEl, next !== undefined ? this.rows.get(next)! : null);
      this.rows.set(row, rowEl);
      this.cells.set(row, new Map());
    }
    // Row spans are only a load hint; drop them rather than keep them stale.
    rowEl.removeAttribute("spans");
    const map = this.cells.get(row)!;
    let c = map.get(col);
    if (!c) {
      c = this.part.el("c");
      c.setAttribute("r", cellRef(col, row));
      const nextCol = [...map.keys()].filter((k) => k > col).sort((a, b) => a - b)[0];
      rowEl.insertBefore(c, nextCol !== undefined ? map.get(nextCol)! : null);
      map.set(col, c);
    }
    return c;
  }

  set(
    col: number,
    row: number,
    value: CellValue,
    opts: { highlight?: boolean | string; style?: number } = {},
  ) {
    const c = this.ensureCell(col, row);
    while (c.firstChild) c.removeChild(c.firstChild);
    c.removeAttribute("t");
    if (opts.style !== undefined && opts.style > 0) c.setAttribute("s", String(opts.style));
    if (typeof value === "number" && Number.isFinite(value)) {
      const v = this.part.el("v");
      v.appendChild(this.part.doc.createTextNode(String(value)));
      c.appendChild(v);
    } else if (value !== null && value !== "") {
      const text = String(value).replace(INVALID_XML_CHARS, "");
      c.setAttribute("t", "inlineStr");
      const is = this.part.el("is");
      const t = this.part.el("t");
      if (text !== text.trim()) t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.appendChild(this.part.doc.createTextNode(text));
      is.appendChild(t);
      c.appendChild(is);
    }
    if (opts.highlight) {
      this.highlight(col, row, typeof opts.highlight === "string" ? opts.highlight : undefined);
    }
    this.part.dirty = true;
  }

  /** Fill a cell (amber by default) while keeping its existing formatting. */
  highlight(col: number, row: number, rgb?: string) {
    const c = this.ensureCell(col, row);
    const base = Number(c.getAttribute("s") ?? 0) || 0;
    c.setAttribute("s", String(this.wb.styles.highlight(base, rgb)));
    this.part.dirty = true;
  }

  /** Remove every row (used when replacing a generated sheet). */
  clear() {
    while (this.sheetData.firstChild) this.sheetData.removeChild(this.sheetData.firstChild);
    this.index();
    this.part.dirty = true;
  }

  /**
   * Insert an empty column after `afterCol`, shifting cells and every range on this
   * sheet (cols, validations, conditional formats, merges, filters, hyperlinks, views).
   */
  insertColumnAfter(afterCol: number) {
    if (
      this.hasElement("tableParts") &&
      childElements(firstChild(this.part.root, "tableParts")).length
    ) {
      throw new Error(
        `Cannot insert a column into "${this.name}": the sheet contains an Excel table.`,
      );
    }
    if (this.hasElement("f")) {
      this.warnings.push(`Formulas on "${this.name}" were not adjusted for the inserted column.`);
    }
    for (const map of this.cells.values()) {
      for (const [col, c] of map) {
        const ref = c.getAttribute("r");
        if (col > afterCol && ref) c.setAttribute("r", shiftRefs(ref, afterCol));
      }
    }
    for (const col of childElements(firstChild(this.part.root, "cols"), "col")) {
      const min = Number(col.getAttribute("min"));
      const max = Number(col.getAttribute("max"));
      if (min > afterCol) col.setAttribute("min", String(min + 1));
      if (max > afterCol) col.setAttribute("max", String(max + 1));
    }
    const all = this.part.doc.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const el = all.item(i)!;
      if (el.localName === "c" || el.localName === "row") continue;
      for (const attr of ["sqref", "ref", "activeCell", "topLeftCell"]) {
        const v = el.getAttribute(attr);
        if (v) el.setAttribute(attr, shiftRefs(v, afterCol));
      }
      if (el.localName === "sqref" && el.textContent)
        el.textContent = shiftRefs(el.textContent, afterCol);
    }
    for (const row of childElements(this.sheetData, "row")) row.removeAttribute("spans");
    this.index();
    this.part.dirty = true;
  }

  updateDimension() {
    const dim = firstChild(this.part.root, "dimension");
    if (!dim) return;
    let maxRow = 0;
    let maxCol = 0;
    for (const [r, map] of this.cells) {
      if (!map.size) continue;
      maxRow = Math.max(maxRow, r);
      maxCol = Math.max(maxCol, ...map.keys());
    }
    dim.setAttribute("ref", maxRow ? `A1:${cellRef(maxCol, maxRow)}` : "A1");
  }

  get partInfo() {
    return this.part;
  }
}

// ---------- workbook ----------

type SheetEntry = { name: string; path: string; el: Element };

export class Workbook {
  private sheetEntries: SheetEntry[] = [];
  private sheetCache = new Map<string, Sheet>();
  private sharedStrings: string[] = [];
  private stylesObj: Styles | null = null;
  private stylesPart: XmlPart | null = null;
  private readonly workbookPart: XmlPart;
  private readonly relsPart: XmlPart;
  private contentTypesPart: XmlPart;
  private readonly workbookDir: string;

  private constructor(
    private readonly zip: JSZip,
    private readonly texts: Map<string, string>,
    workbookPath: string,
    private readonly stylesPath: string | null,
  ) {
    this.workbookDir = workbookPath.split("/").slice(0, -1).join("/");
    this.workbookPart = new XmlPart(workbookPath, texts.get(workbookPath)!, MAIN);
    const relsPath = `${this.workbookDir}/_rels/${workbookPath.split("/").pop()}.rels`;
    this.relsPart = new XmlPart(relsPath, texts.get(relsPath)!, PKG_REL);
    this.contentTypesPart = new XmlPart(
      "[Content_Types].xml",
      texts.get("[Content_Types].xml")!,
      "",
    );
    const rels = new Map(
      childElements(this.relsPart.root, "Relationship").map((r) => [
        r.getAttribute("Id")!,
        resolveTarget(this.workbookDir, r.getAttribute("Target")!),
      ]),
    );
    const sheets = firstChild(this.workbookPart.root, "sheets");
    for (const el of childElements(sheets, "sheet")) {
      const rid = el.getAttributeNS(DOC_REL, "id") ?? el.getAttribute("r:id");
      const path = rid ? rels.get(rid) : undefined;
      if (path) this.sheetEntries.push({ name: el.getAttribute("name") ?? "", path, el });
    }
  }

  static async load(data: Uint8Array | ArrayBuffer): Promise<Workbook> {
    const zip = await JSZip.loadAsync(data);
    const read = async (p: string) => (await zip.file(p)?.async("string")) ?? null;
    const texts = new Map<string, string>();
    const rootRels = await read("_rels/.rels");
    if (!rootRels) throw new Error("Not an Excel workbook (missing _rels/.rels).");
    const officeDoc = childElements(parseXml(rootRels).documentElement, "Relationship").find((r) =>
      (r.getAttribute("Type") ?? "").endsWith("/officeDocument"),
    );
    const workbookPath = resolveTarget("", officeDoc?.getAttribute("Target") ?? "xl/workbook.xml");
    const dir = workbookPath.split("/").slice(0, -1).join("/");
    const wbRelsPath = `${dir}/_rels/${workbookPath.split("/").pop()}.rels`;
    for (const p of [workbookPath, wbRelsPath, "[Content_Types].xml"]) {
      const t = await read(p);
      if (t === null) throw new Error(`Not an Excel workbook (missing ${p}).`);
      texts.set(p, t);
    }
    // Pre-read every part we might parse later, so sheet access can stay synchronous.
    const relsDoc = parseXml(texts.get(wbRelsPath)!);
    let stylesPath: string | null = null;
    let sharedPath: string | null = null;
    for (const r of childElements(relsDoc.documentElement, "Relationship")) {
      const type = r.getAttribute("Type") ?? "";
      const target = resolveTarget(dir, r.getAttribute("Target") ?? "");
      if (type.endsWith("/styles")) stylesPath = target;
      if (type.endsWith("/sharedStrings")) sharedPath = target;
      if (
        type.endsWith("/worksheet") ||
        type.endsWith("/styles") ||
        type.endsWith("/sharedStrings")
      ) {
        const t = await read(target);
        if (t !== null) texts.set(target, t);
      }
    }
    const wb = new Workbook(zip, texts, workbookPath, stylesPath);
    if (sharedPath && texts.has(sharedPath)) {
      const doc = parseXml(texts.get(sharedPath)!);
      wb.sharedStrings = childElements(doc.documentElement, "si").map(textOf);
    }
    return wb;
  }

  get sheetNames(): string[] {
    return this.sheetEntries.map((s) => s.name);
  }

  hasSheet(name: string): boolean {
    return this.sheetEntries.some((s) => s.name === name);
  }

  sheet(name: string): Sheet {
    const cached = this.sheetCache.get(name);
    if (cached) return cached;
    const entry = this.sheetEntries.find((s) => s.name === name);
    if (!entry) throw new Error(`Sheet "${name}" not found.`);
    const text = this.texts.get(entry.path);
    if (text === undefined) throw new Error(`Sheet "${name}" could not be read.`);
    const sheet = new Sheet(this, name, new XmlPart(entry.path, text, MAIN));
    this.sheetCache.set(name, sheet);
    return sheet;
  }

  get styles(): Styles {
    if (!this.stylesObj) {
      if (!this.stylesPath || !this.texts.has(this.stylesPath))
        throw new Error("Workbook has no styles part.");
      this.stylesPart = new XmlPart(this.stylesPath, this.texts.get(this.stylesPath)!, MAIN);
      this.stylesObj = new Styles(this.stylesPart);
    }
    return this.stylesObj;
  }

  cellValue(c: Element): CellValue {
    const t = c.getAttribute("t");
    if (t === "inlineStr") {
      const is = firstChild(c, "is");
      return is ? textOf(is) : null;
    }
    const v = firstChild(c, "v");
    const raw = v?.textContent ?? null;
    if (raw === null) return null;
    if (t === "s") return this.sharedStrings[Number(raw)] ?? null;
    if (t === "b") return raw === "1" ? "TRUE" : "FALSE";
    if (t === "str" || t === "e" || t === "d") return raw;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }

  /** Returns an empty sheet with this name, clearing it if it already exists or appending it otherwise. */
  addOrReplaceSheet(name: string): Sheet {
    if (this.hasSheet(name)) {
      const sheet = this.sheet(name);
      sheet.clear();
      return sheet;
    }
    const wsDir = `${this.workbookDir}/worksheets`;
    let n = this.sheetEntries.length + 1;
    while (this.zip.file(`${wsDir}/sheet${n}.xml`) || this.texts.has(`${wsDir}/sheet${n}.xml`)) n++;
    const path = `${wsDir}/sheet${n}.xml`;
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheetData/></worksheet>`;
    this.texts.set(path, xml);

    const rels = this.relsPart;
    const ids = new Set(childElements(rels.root, "Relationship").map((r) => r.getAttribute("Id")));
    let k = 1;
    while (ids.has(`rIdAm${k}`)) k++;
    const rid = `rIdAm${k}`;
    const rel = rels.el("Relationship", PKG_REL);
    rel.setAttribute("Id", rid);
    rel.setAttribute("Type", WORKSHEET_TYPE);
    rel.setAttribute("Target", `worksheets/sheet${n}.xml`);
    rels.root.appendChild(rel);
    rels.dirty = true;

    const ct = this.contentTypesPart;
    const override = ct.el("Override", ct.root.namespaceURI ?? "");
    override.setAttribute("PartName", `/${path}`);
    override.setAttribute("ContentType", WORKSHEET_CT);
    ct.root.appendChild(override);
    ct.dirty = true;

    const wbp = this.workbookPart;
    const sheets = firstChild(wbp.root, "sheets")!;
    const maxId = Math.max(
      0,
      ...childElements(sheets, "sheet").map((s) => Number(s.getAttribute("sheetId")) || 0),
    );
    const el = wbp.el("sheet");
    el.setAttribute("name", name);
    el.setAttribute("sheetId", String(maxId + 1));
    if (!wbp.root.lookupPrefix(DOC_REL)) el.setAttributeNS(XMLNS_NS, "xmlns:r", DOC_REL);
    el.setAttributeNS(DOC_REL, "r:id", rid);
    sheets.appendChild(el);
    wbp.dirty = true;

    this.sheetEntries.push({ name, path, el });
    const sheet = this.sheet(name);
    sheet.partInfo.dirty = true;
    return sheet;
  }

  async save(): Promise<Uint8Array> {
    for (const sheet of this.sheetCache.values()) {
      const part = sheet.partInfo;
      if (!part.dirty) continue;
      sheet.updateDimension();
      this.zip.file(part.path, part.serialize(), { createFolders: false });
    }
    for (const part of [this.stylesPart, this.workbookPart, this.relsPart, this.contentTypesPart]) {
      if (part?.dirty) this.zip.file(part.path, part.serialize(), { createFolders: false });
    }
    return this.zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }
}
