import type {
  AnalysisResult,
  AppTypeCount,
  Flag,
  MappingEntry,
  OutputFile,
  RunResult,
  TemplateAnalysis,
  TemplateColumns,
  TemplateRunResult,
  TemplateSelection,
  ClientColumns,
  ClientSheets,
  SheetInfo,
  SupportingDocsOptions,
  SupportingSummary,
} from "@/lib/transform/types";
import { ALL_ROWS_APP_TYPE, DEFAULT_MANDATORY } from "@/lib/transform/types";
import { matchTemplates, readSystemNames, templateLabel } from "./appTypes";
import { readDropdowns, suggestOption } from "./dropdowns";
import { autoMap, defaultFuzzy, parseMappingFile, type MappingPair } from "./mapping";
import {
  excelSerialToIso,
  findColumn,
  findSheet,
  isBlank,
  isDateHeader,
  looseHeader,
  normalizeHeader,
  readTable,
  type Table,
} from "./read";
import { cellRef, CORRECTED_RGB, type CellValue, Workbook } from "./workbook";

export class TransformError extends Error {}

export type InputFile = { name: string; data: Uint8Array };
export type PipelineFiles = {
  client: InputFile;
  templates: InputFile[];
  mappingFile?: InputFile | undefined;
};
export type PipelineOptions = {
  prefix: string;
  /** Client sheet holding the records (default: detected "Metadata Extraction"). */
  metadataSheet?: string | undefined;
  /** Client sheet listing the SharePoint files (default: detected "Files on SP"). */
  filesSheet?: string | undefined;
  /** Also return the updated client workbook (File Path tab, highlights, Flags tab). */
  includeClientWorkbook?: boolean | undefined;
  /** Key columns chosen in the UI (header texts); detected when omitted. */
  columns?: ClientColumns | undefined;
  /** Per-template choices from the UI; templates without one use the automatic match. */
  templates?: TemplateSelection[] | undefined;
  mandatory?: string[] | undefined;
  /** Link supporting documents to their parents (Supporting Document sheet). */
  supportingDocs?: SupportingDocsOptions | undefined;
};

// ---------- file paths ----------

/**
 * Remove everything up to and including `prefix` from the folder, then append the file
 * name. The prefix may be the full URL start or any later part of the path, e.g.
 * "Enstructure/Shared Documents/Client folder/LegacyMigration/".
 */
export function buildFilePath(
  folder: string,
  fileName: string,
  prefix: string,
): { path: string; prefixFound: boolean } {
  let rest = folder.trim();
  const p = prefix.trim();
  const at = p ? rest.toLowerCase().indexOf(p.toLowerCase()) : 0;
  const prefixFound = at >= 0;
  if (p && prefixFound) rest = rest.slice(at + p.length);
  rest = rest.replace(/^\/+/, "");
  if (rest && !rest.endsWith("/")) rest += "/";
  return { path: `${rest}${fileName.trim()}`, prefixFound };
}

type FileEntry = { row: number; name: string; folder: string; path: string; prefixFound: boolean };

const FILES_NAME_HEADERS = ["Name", "File Name", "File Name (with extension)"];
const FOLDER_HEADERS = ["Folder Path", "Path"];
const FILE_NAME_HEADERS = ["File Name (with extension)", "File Name", "Name"];
const APP_TYPE_HEADERS = ["Application Type", "App Type"];
const DOC_TYPE_HEADERS = ["Doc Type", "Document Type"];
const PARENT_DOC_HEADERS = [
  "Parent Doc Names",
  "Parent Doc Name",
  "Parent Document Names",
  "Parent Document Name",
  "Parent Document",
  "Parent File Name",
];
/** Distinct values listed for a column in the UI (e.g. Doc Type) when it has at most this many. */
const MAX_LISTED_VALUES = 30;

/** Parent document column: a known header, else one that mentions a parent doc or file. */
function findParentDocColumn(table: Table): number | null {
  return (
    findColumn(table, ...PARENT_DOC_HEADERS) ??
    table.headers.find(
      (h) => /parent/i.test(h.text) && /doc|file/i.test(h.text) && !/reference id/i.test(h.text),
    )?.col ??
    null
  );
}

/** Only Parent-Main Agreement rows become Contract Request rows (others are amendments etc.). */
function isRequestRow(meta: Table, docTypeCol: number | null, row: number): boolean {
  if (!docTypeCol) return true;
  return String(meta.sheet.get(docTypeCol, row) ?? "")
    .trim()
    .toLowerCase()
    .startsWith("parent");
}

/** App type of a row; every row shares one app type when the sheet has no such column. */
function appTypeOf(meta: Table, appTypeCol: number | null, row: number): string {
  if (!appTypeCol) return ALL_ROWS_APP_TYPE;
  return String(meta.sheet.get(appTypeCol, row) ?? "").trim();
}

/** Column of the header the user chose, or the detected one when nothing was chosen. */
function keyColumn(table: Table, chosen: string | undefined, fallbacks: string[]): number | null {
  if (chosen) {
    return (
      table.headers.find((h) => normalizeHeader(h.text) === normalizeHeader(chosen))?.col ?? null
    );
  }
  return findColumn(table, ...fallbacks);
}

function readFileEntries(table: Table, prefix: string, columns?: ClientColumns): FileEntry[] {
  const nameCol = keyColumn(table, columns?.filesName, FILES_NAME_HEADERS);
  const folderCol = keyColumn(table, columns?.filesFolder, FOLDER_HEADERS);
  if (!nameCol || !folderCol) {
    throw new TransformError(
      `Choose the file name and folder path columns of the SharePoint files sheet "${table.sheet.name}".`,
    );
  }
  const out: FileEntry[] = [];
  for (const row of table.dataRows) {
    const name = table.sheet.get(nameCol, row);
    if (isBlank(name)) continue;
    const folder = String(table.sheet.get(folderCol, row) ?? "");
    out.push({
      row,
      name: String(name).trim(),
      folder,
      ...buildFilePath(folder, String(name), prefix),
    });
  }
  return out;
}

// SharePoint stores characters it doesn't allow in file names (e.g. "*") as "_".
const sharePointName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[*:<>?"\\|]/g, "_");

class PathLookup {
  private lower = new Map<string, string>();
  private sanitized = new Map<string, string>();
  private paths = new Map<string, Set<string>>();
  constructor(entries: FileEntry[]) {
    for (const e of entries) {
      const k = e.name.toLowerCase();
      if (!this.lower.has(k)) this.lower.set(k, e.path);
      const s = sharePointName(e.name);
      if (!this.sanitized.has(s)) this.sanitized.set(s, e.path);
      const set = this.paths.get(k) ?? new Set<string>();
      set.add(e.path);
      this.paths.set(k, set);
    }
  }
  /** First case-insensitive match (same rule as Excel's VLOOKUP), then the SharePoint-sanitized name. */
  get(name: string): string | undefined {
    const n = name.trim();
    return this.lower.get(n.toLowerCase()) ?? this.sanitized.get(sharePointName(n));
  }
  isDuplicate(name: string): boolean {
    return (this.paths.get(name.trim().toLowerCase())?.size ?? 0) > 1;
  }
}

// ---------- client workbook ----------

const FILE_NAME_HEADER = "File Name (with extension)";

async function openClient(file: InputFile): Promise<Workbook> {
  return Workbook.load(file.data).catch((e: Error) => {
    throw new TransformError(`Client workbook: ${e.message}`);
  });
}

function detectFilesSheet(wb: Workbook): string | null {
  return findSheet(wb, ["Files on SP"], (t) =>
    t.headers.some((h) => looseHeader(h.text) === "folder path"),
  );
}

function detectMetadataSheet(wb: Workbook): string | null {
  return findSheet(wb, ["Metadata Extraction"], (t) =>
    t.headers.some((h) => normalizeHeader(h.text) === normalizeHeader(FILE_NAME_HEADER)),
  );
}

function chosenSheet(wb: Workbook, name: string | undefined, role: string): string | undefined {
  if (name && !wb.hasSheet(name))
    throw new TransformError(`The ${role} sheet "${name}" is not in the client workbook.`);
  return name || undefined;
}

/** List the client workbook's sheets so the user can pick the main data sheet first. */
export async function inspectClient(file: InputFile): Promise<ClientSheets> {
  const wb = await openClient(file);
  const sheets = wb.sheetNames.map((name): SheetInfo => {
    const guess = {
      fileName: null,
      appType: null,
      filesName: null,
      filesFolder: null,
      docType: null,
      parentDoc: null,
    };
    try {
      const table = readTable(wb.sheet(name));
      const text = (col: number | null) => table.headers.find((h) => h.col === col)?.text ?? null;
      const samples: Record<string, string> = {};
      const values: Record<string, string[]> = {};
      for (const h of table.headers) {
        const row = table.dataRows.find((r) => !isBlank(table.sheet.get(h.col, r)));
        if (row !== undefined) samples[h.text] = display(table.sheet.get(h.col, row), h.text);
        const distinct = new Set<string>();
        for (const r of table.dataRows) {
          const v = table.sheet.get(h.col, r);
          if (isBlank(v)) continue;
          distinct.add(String(v).trim());
          if (distinct.size > MAX_LISTED_VALUES) break;
        }
        if (distinct.size && distinct.size <= MAX_LISTED_VALUES) values[h.text] = [...distinct];
      }
      return {
        name,
        rows: table.dataRows.length,
        headers: table.headers.map((h) => h.text),
        samples,
        values,
        guess: {
          fileName: text(findColumn(table, ...FILE_NAME_HEADERS)),
          appType: text(findColumn(table, ...APP_TYPE_HEADERS)),
          filesName: text(findColumn(table, ...FILES_NAME_HEADERS)),
          filesFolder: text(findColumn(table, ...FOLDER_HEADERS)),
          docType: text(findColumn(table, ...DOC_TYPE_HEADERS)),
          parentDoc: text(findParentDocColumn(table)),
        },
      };
    } catch {
      return { name, rows: 0, headers: [], samples: {}, values: {}, guess };
    }
  });
  return { sheets, metadataSheet: detectMetadataSheet(wb), filesSheet: detectFilesSheet(wb) };
}

async function loadClient(file: InputFile, opts: PipelineOptions) {
  const wb = await openClient(file);
  const filesSheet = chosenSheet(wb, opts.filesSheet, "SharePoint files") ?? detectFilesSheet(wb);
  const metadataSheet = chosenSheet(wb, opts.metadataSheet, "main data") ?? detectMetadataSheet(wb);
  if (!metadataSheet)
    throw new TransformError("Choose the main data sheet of the client workbook.");
  const meta = readTable(wb.sheet(metadataSheet));
  const fileNameCol = keyColumn(meta, opts.columns?.fileName, FILE_NAME_HEADERS);
  if (!fileNameCol)
    throw new TransformError(
      `Choose the file name column of the main data sheet "${metadataSheet}".`,
    );
  // Optional: without an application type column every row belongs to one group.
  const appTypeCol = keyColumn(meta, opts.columns?.appType, APP_TYPE_HEADERS);
  const appTypeHeader = meta.headers.find((h) => h.col === appTypeCol)?.text ?? null;
  const docTypeCol = keyColumn(meta, opts.columns?.docType, DOC_TYPE_HEADERS);
  if (opts.columns?.docType && !docTypeCol)
    throw new TransformError(`Column "${opts.columns.docType}" is not on "${metadataSheet}".`);
  const docTypeHeader = meta.headers.find((h) => h.col === docTypeCol)?.text ?? null;

  let links: SupportingLinks | null = null;
  let parentDocHeader: string | null = null;
  if (opts.supportingDocs) {
    const parentCol = opts.columns?.parentDoc
      ? keyColumn(meta, opts.columns.parentDoc, [])
      : findParentDocColumn(meta);
    if (!docTypeCol || !parentCol)
      throw new TransformError(
        `To link supporting documents, choose the doc type and parent document columns of "${metadataSheet}".`,
      );
    if (!opts.supportingDocs.types.length)
      throw new TransformError("Choose which doc types are supporting documents.");
    parentDocHeader = meta.headers.find((h) => h.col === parentCol)?.text ?? null;
    links = linkSupporting(meta, fileNameCol, docTypeCol, parentCol, opts.supportingDocs.types);
  }

  const systemNames = readSystemNames(wb);
  const counts = new Map<string, number>();
  let requestRows = 0;
  for (const r of meta.dataRows) {
    if (!isRequestRow(meta, docTypeCol, r)) continue;
    requestRows++;
    const t = appTypeOf(meta, appTypeCol, r);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const appTypes: AppTypeCount[] = [...counts]
    .map(([name, count]) => ({ name, count, systemName: systemNames.get(name) ?? null }))
    .sort((a, b) => b.count - a.count);
  return {
    wb,
    filesSheet,
    metadataSheet,
    meta,
    fileNameCol,
    appTypeCol,
    appTypeHeader,
    docTypeHeader,
    parentDocHeader,
    links,
    requestRows,
    appTypes,
  };
}

// ---------- supporting documents ----------

type SupportingLinks = {
  /** Supporting document rows, in sheet order. */
  rows: number[];
  /** Supporting row -> its parent's (Contract Request) row. */
  parentOf: Map<number, number>;
  /** Why a supporting row has no parent. */
  problem: Map<number, "no-parent-name" | "parent-not-found">;
  /** Supporting rows whose parent name matched several Contract Request rows. */
  ambiguous: Set<number>;
};

/** File name as written in a parent-name cell or a file name column, for comparing. */
function docKey(name: unknown): string {
  return sharePointName(
    String(name ?? "")
      .replace(/\\/g, "/")
      .split("/")
      .pop() ?? "",
  );
}

/**
 * Find each supporting document's parent: the Contract Request (Parent-Main Agreement)
 * row whose file name is the supporting row's parent document name.
 */
function linkSupporting(
  meta: Table,
  fileNameCol: number,
  docTypeCol: number,
  parentCol: number,
  types: string[],
): SupportingLinks {
  const wanted = new Set(types.map((t) => t.trim().toLowerCase()));
  const parents = new Map<string, number[]>();
  for (const r of meta.dataRows) {
    if (!isRequestRow(meta, docTypeCol, r)) continue;
    const key = docKey(meta.sheet.get(fileNameCol, r));
    if (key) parents.set(key, [...(parents.get(key) ?? []), r]);
  }
  const links: SupportingLinks = {
    rows: [],
    parentOf: new Map(),
    problem: new Map(),
    ambiguous: new Set(),
  };
  for (const r of meta.dataRows) {
    const type = String(meta.sheet.get(docTypeCol, r) ?? "")
      .trim()
      .toLowerCase();
    if (!wanted.has(type)) continue;
    links.rows.push(r);
    const key = docKey(meta.sheet.get(parentCol, r));
    if (!key) {
      links.problem.set(r, "no-parent-name");
      continue;
    }
    const found = parents.get(key);
    if (!found) {
      links.problem.set(r, "parent-not-found");
      continue;
    }
    links.parentOf.set(r, found[0]!);
    if (found.length > 1) links.ambiguous.add(r);
  }
  return links;
}

function supportingSummary(
  links: SupportingLinks,
  meta: Table,
  appTypeCol: number | null,
): SupportingSummary {
  const byAppType: Record<string, number> = {};
  for (const parent of links.parentOf.values()) {
    const t = appTypeOf(meta, appTypeCol, parent);
    byAppType[t] = (byAppType[t] ?? 0) + 1;
  }
  const problems = [...links.problem.values()];
  return {
    total: links.rows.length,
    linked: links.parentOf.size,
    noParentName: problems.filter((p) => p === "no-parent-name").length,
    parentNotFound: problems.filter((p) => p === "parent-not-found").length,
    ambiguousParent: links.ambiguous.size,
    byAppType,
  };
}

/** Contract Request rows of the given app types, in sheet order. */
function rowsOfTypes(
  meta: Table,
  appTypeCol: number | null,
  appTypes: string[],
  docTypeCol: number | null,
): number[] {
  const wanted = new Set(appTypes);
  return meta.dataRows.filter(
    (r) => wanted.has(appTypeOf(meta, appTypeCol, r)) && isRequestRow(meta, docTypeCol, r),
  );
}

// ---------- templates ----------

async function loadTemplate(
  file: InputFile,
  clientHeaders: string[],
  pairs: MappingPair[],
  mandatory: string[],
) {
  const wb = await Workbook.load(file.data).catch((e: Error) => {
    throw new TransformError(`Not a readable Excel file (${e.message}).`);
  });
  const requestName = findSheet(wb, ["Contract Request"]);
  const versionName = findSheet(wb, ["Contract Version"]);
  if (!requestName || !versionName) {
    throw new TransformError('A template needs "Contract Request" and "Contract Version" sheets.');
  }
  const request = readTable(wb.sheet(requestName));
  const version = readTable(wb.sheet(versionName));
  const requestDropdowns = readDropdowns(wb, request.sheet);
  const versionDropdowns = readDropdowns(wb, version.sheet);
  const supportingName = findSheet(wb, ["Supporting Document"]);
  const supporting = supportingName ? readTable(wb.sheet(supportingName)) : null;
  const supportingDropdowns = supporting ? readDropdowns(wb, supporting.sheet) : new Map();
  const refCol = findColumn(request, "Record Reference Id");
  if (!refCol) throw new TransformError('Contract Request has no "Record Reference Id" column.');
  const templateRows = request.dataRows.filter((r) => !isBlank(request.sheet.get(refCol, r)));
  const dropdownHeaders = new Set(
    request.headers.filter((h) => requestDropdowns.has(h.col)).map((h) => h.text),
  );
  const auto = autoMap(
    request.headers.map((h) => h.text),
    clientHeaders,
    { dropdownHeaders, mandatory, pairs },
  );
  return {
    wb,
    request,
    version,
    requestDropdowns,
    versionDropdowns,
    supporting,
    supportingDropdowns,
    refCol,
    templateRows,
    dropdownHeaders,
    auto,
  };
}

type TemplateContext = Awaited<ReturnType<typeof loadTemplate>>;
type LoadedTemplate = {
  index: number;
  file: InputFile;
  ctx: TemplateContext | null;
  error?: string;
};

async function loadTemplates(
  files: Pick<PipelineFiles, "templates" | "mappingFile">,
  clientHeaders: string[],
  opts: PipelineOptions,
): Promise<LoadedTemplate[]> {
  const pairs = files.mappingFile
    ? await parseMappingFile(files.mappingFile.name, files.mappingFile.data)
    : [];
  const mandatory = opts.mandatory ?? DEFAULT_MANDATORY;
  return Promise.all(
    files.templates.map(async (file, index): Promise<LoadedTemplate> => {
      try {
        return { index, file, ctx: await loadTemplate(file, clientHeaders, pairs, mandatory) };
      } catch (e) {
        if (e instanceof TransformError) return { index, file, ctx: null, error: e.message };
        throw e;
      }
    }),
  );
}

function templateColumns(t: LoadedTemplate): TemplateColumns {
  return {
    index: t.index,
    fileName: t.file.name,
    label: templateLabel(t.file.name),
    requestHeaders: t.ctx?.request.headers.map((h) => h.text) ?? [],
    dropdownColumns: t.ctx ? [...t.ctx.dropdownHeaders] : [],
    mapping: t.ctx?.auto.entries ?? [],
    mappingFileWarnings: t.ctx?.auto.warnings ?? [],
    ...(t.error ? { error: t.error } : {}),
  };
}

/**
 * Read each template's headers and propose a mapping against the chosen client sheet's
 * headers. Needs no client workbook, so the mapping can be shown before analysis.
 */
export async function inspectTemplates(
  files: Pick<PipelineFiles, "templates" | "mappingFile">,
  clientHeaders: string[],
  opts: Pick<PipelineOptions, "mandatory"> = {},
): Promise<TemplateColumns[]> {
  const templates = await loadTemplates(files, clientHeaders, { prefix: "", ...opts });
  return templates.map(templateColumns);
}

/** Automatic app type per template index (unreadable templates never take an app type). */
function autoAppTypes(
  templates: LoadedTemplate[],
  appTypes: AppTypeCount[],
  hasAppTypeColumn: boolean,
) {
  const valid = templates.filter((t) => t.ctx);
  if (!hasAppTypeColumn) {
    // No names to match: all rows go to the template with the same row count, else the first.
    const count = appTypes[0]?.count ?? 0;
    const pick = valid.find((t) => t.ctx!.templateRows.length === count) ?? valid[0];
    return new Map(
      valid.map((t) => [
        t.index,
        t === pick && count
          ? { appTypes: [ALL_ROWS_APP_TYPE], score: 1 }
          : { appTypes: [], score: 0 },
      ]),
    );
  }
  const matches = matchTemplates(
    valid.map((t) => ({ label: templateLabel(t.file.name), rows: t.ctx!.templateRows.length })),
    appTypes,
  );
  return new Map(valid.map((t, i) => [t.index, matches[i]!]));
}

function display(v: CellValue, header: string): string {
  if (typeof v === "number" && isDateHeader(header)) return excelSerialToIso(v);
  return v === null ? "" : String(v);
}

// ---------- analyze ----------

export async function analyze(
  files: PipelineFiles,
  opts: PipelineOptions,
): Promise<AnalysisResult> {
  const c = await loadClient(files.client, opts);
  const entries = c.filesSheet
    ? readFileEntries(readTable(c.wb.sheet(c.filesSheet)), opts.prefix, opts.columns)
    : [];
  const lookup = new PathLookup(entries);
  const metaNames = c.meta.dataRows
    .map((r) => c.meta.sheet.get(c.fileNameCol, r))
    .filter((n) => !isBlank(n))
    .map(String);

  const templates = await loadTemplates(
    files,
    c.meta.headers.map((h) => h.text),
    opts,
  );
  const matches = autoAppTypes(templates, c.appTypes, c.appTypeCol !== null);

  const samples: Record<string, Record<string, string>> = {};
  for (const a of c.appTypes) {
    const rows = rowsOfTypes(
      c.meta,
      c.appTypeCol,
      [a.name],
      findColumn(c.meta, ...DOC_TYPE_HEADERS),
    );
    const record: Record<string, string> = {};
    for (const h of c.meta.headers) {
      const row = rows.find((r) => !isBlank(c.meta.sheet.get(h.col, r)));
      if (row !== undefined) record[h.text] = display(c.meta.sheet.get(h.col, row), h.text);
    }
    samples[a.name] = record;
  }

  return {
    client: {
      fileName: files.client.name,
      sheets: c.wb.sheetNames,
      filesSheet: c.filesSheet,
      metadataSheet: c.metadataSheet,
      metadataHeaders: c.meta.headers.map((h) => h.text),
      appTypeColumn: c.appTypeHeader,
      docTypeColumn: c.docTypeHeader,
      totalRows: c.meta.dataRows.length,
      requestRows: c.requestRows,
      appTypes: c.appTypes,
      ...(c.links ? { supporting: supportingSummary(c.links, c.meta, c.appTypeCol) } : {}),
    },
    templates: templates.map((t): TemplateAnalysis => {
      const match = matches.get(t.index);
      return {
        ...templateColumns(t),
        appTypes: match?.appTypes ?? [],
        matchScore: match?.score ?? 0,
        templateRows: t.ctx?.templateRows.length ?? 0,
      };
    }),
    filePaths: {
      total: entries.length,
      missingPrefix: entries.filter((e) => !e.prefixFound).length,
      preview: entries
        .slice(0, 20)
        .map((e) => ({ fileName: e.name, folder: e.folder, filePath: e.path })),
      metadataUnmatched: metaNames.filter((n) => !lookup.get(n)).length,
      duplicateNames: metaNames.filter((n) => lookup.get(n) && lookup.isDuplicate(n)).length,
    },
    samples,
  };
}

// ---------- run ----------

function outputName(name: string, suffix: string): string {
  const m = /^(.*?)(\.[^.]+)?$/.exec(name);
  return `${m?.[1] ?? name}_${suffix}${m?.[2] ?? ".xlsx"}`;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type FillInput = {
  meta: Table;
  appTypeCol: number | null;
  fileNameCol: number;
  tpl: TemplateContext;
  templateName: string;
  appTypes: string[];
  docTypeCol: number | null;
  mapping: MappingEntry[];
  filePathByRow: Map<number, string>;
  /** Present when supporting documents are linked to their parents. */
  supporting: {
    /** Contract Request (parent) row -> its supporting document rows, in sheet order. */
    childrenOf: Map<number, number[]>;
    /** Supporting rows whose parent file name matched several parents. */
    ambiguous: Set<number>;
    parentDocCol: number | null;
  } | null;
};

const SUPPORTING_DOCUMENT_TYPE = "Supporting Document";

/**
 * Write the supporting documents of the template's parents into its Supporting Document
 * sheet: each under its parent's Record Reference Id, numbered 1..n per parent.
 * Returns the supporting rows written (none when the sheet is missing or unusable).
 */
function fillSupporting(
  input: FillInput,
  sourceRows: number[],
  flag: (f: Omit<Flag, "template">) => void,
  issueRows: Set<number>,
): number[] {
  const { meta, tpl, filePathByRow, supporting } = input;
  if (!supporting) return [];
  const children = sourceRows.flatMap((parent, i) =>
    (supporting.childrenOf.get(parent) ?? []).map((child) => ({
      child,
      parentRef: tpl.request.sheet.get(tpl.refCol, tpl.templateRows[i]!),
    })),
  );
  if (!children.length) return [];

  const sd = tpl.supporting;
  const col = sd && {
    ref: findColumn(sd, "Record Reference Id"),
    docRef: findColumn(sd, "Document Reference Id"),
    file: findColumn(sd, "Document File (with extension)", "Document File"),
    type: findColumn(sd, "Document Type"),
  };
  if (!sd || !col || !col.ref || !col.docRef || !col.file) {
    flag({
      kind: "supporting",
      workbook: "template",
      sheet: sd?.sheet.name ?? "Supporting Document",
      cell: "—",
      column: "",
      value: `${children.length} supporting documents`,
      message: sd
        ? "The Supporting Document sheet is missing one of its expected columns; supporting documents were not written."
        : "The template has no Supporting Document sheet; supporting documents were not written.",
    });
    return [];
  }

  let docType = SUPPORTING_DOCUMENT_TYPE;
  const options = col.type ? tpl.supportingDropdowns.get(col.type) : undefined;
  if (options && !options.includes(docType)) {
    const closest = suggestOption(docType, options) ?? options[0]!;
    flag({
      kind: "supporting",
      workbook: "template",
      sheet: sd.sheet.name,
      cell: cellRef(col.type!, sd.headerRow + 1),
      column: "Document Type",
      value: docType,
      message: `"${docType}" is not a dropdown option; used "${closest}".`,
      suggestion: closest,
    });
    docType = closest;
  }

  // Start below anything already on the sheet.
  let row = sd.headerRow + 1;
  while (!isBlank(sd.sheet.get(col.ref, row))) row++;
  const numbers = new Map<string, number>();
  for (const { child, parentRef } of children) {
    const n = (numbers.get(String(parentRef)) ?? 0) + 1;
    numbers.set(String(parentRef), n);
    sd.sheet.set(col.ref, row, parentRef);
    sd.sheet.set(col.docRef, row, n);
    const path = filePathByRow.get(child) ?? null;
    sd.sheet.set(col.file, row, path, { highlight: !path });
    if (col.type) sd.sheet.set(col.type, row, docType);
    const name = String(meta.sheet.get(input.fileNameCol, child) ?? "");
    if (!path) {
      issueRows.add(child);
      flag({
        kind: "file-path",
        workbook: "template",
        sheet: sd.sheet.name,
        cell: cellRef(col.file, row),
        column: "Document File (with extension)",
        value: name,
        message: "No file path found for this supporting document.",
      });
    }
    if (supporting.ambiguous.has(child)) {
      issueRows.add(child);
      const parentName = supporting.parentDocCol
        ? String(meta.sheet.get(supporting.parentDocCol, child) ?? "")
        : "";
      flag({
        kind: "supporting",
        workbook: "template",
        sheet: sd.sheet.name,
        cell: cellRef(col.ref, row),
        column: "Record Reference Id",
        value: name,
        message: `Several Parent-Main Agreement rows have the file name "${parentName}"; linked to the first (Record Reference Id ${String(parentRef)}).`,
      });
    }
    row++;
  }
  return children.map((c) => c.child);
}

/**
 * Fill one template's Contract Request and Contract Version sheets. Every check that can
 * reject the template runs before anything is written, so a skipped template leaves no
 * highlights behind in the client workbook.
 */
function fillTemplate(input: FillInput): {
  rows: number[];
  flags: Flag[];
  /** Rows of the working sheet with an issue to review. */
  issueRows: Set<number>;
  /** Supporting document rows written to the Supporting Document sheet. */
  supportingRows: number[];
} {
  const { meta, tpl, templateName, appTypes, mapping, filePathByRow } = input;
  const { request, version } = tpl;
  const flags: Flag[] = [];
  const issueRows = new Set<number>();
  const flag = (f: Omit<Flag, "template">) => flags.push({ ...f, template: templateName });

  const sourceRows = rowsOfTypes(meta, input.appTypeCol, appTypes, input.docTypeCol);
  if (sourceRows.length !== tpl.templateRows.length) {
    const names = appTypes.map((a) => `"${a}"`).join(" + ");
    throw new TransformError(
      `${names} has ${sourceRows.length} rows in ${meta.sheet.name} but the template has ${tpl.templateRows.length} Record Reference Ids.`,
    );
  }
  const missingMandatory = mapping
    .filter((m) => m.mandatory && !m.client && !m.reserved)
    .map((m) => m.template);
  if (missingMandatory.length)
    throw new TransformError(`Map the mandatory columns first: ${missingMandatory.join(", ")}.`);
  const resolved = mapping
    .filter((m) => !m.reserved && m.client)
    .map((m) => {
      const templateCol = request.headers.find(
        (h) => normalizeHeader(h.text) === normalizeHeader(m.template),
      )?.col;
      const clientCol = meta.headers.find(
        (h) => normalizeHeader(h.text) === normalizeHeader(m.client!),
      )?.col;
      if (!templateCol) throw new TransformError(`Template column "${m.template}" not found.`);
      if (!clientCol) throw new TransformError(`Client column "${m.client}" not found.`);
      const options = tpl.requestDropdowns.get(templateCol);
      // Older saved mappings have no fuzzy setting: fall back to the default for the column.
      const fuzzy = Boolean(options) && (m.fuzzy ?? defaultFuzzy(m.template));
      return { ...m, templateCol, clientCol, options, fuzzy };
    });
  const cv = {
    ref: findColumn(version, "Record Reference Id"),
    file: findColumn(version, "Contract Version file (with extension)", "Contract Version file"),
    number: findColumn(version, "Version Number"),
    signedCopy: findColumn(version, "Is final signed copy?"),
    ai: findColumn(version, "Is AI?"),
    signedOn: findColumn(version, "Signed On"),
  };
  if (!cv.ref || !cv.file || !cv.number || !cv.signedCopy || !cv.ai) {
    throw new TransformError("Contract Version is missing one of its expected columns.");
  }

  // Contract Request, in Metadata Extraction order.
  sourceRows.forEach((metaRow, i) => {
    const tRow = tpl.templateRows[i]!;
    for (const m of resolved) {
      const raw = meta.sheet.get(m.clientCol, metaRow);
      const tCell = cellRef(m.templateCol, tRow);
      const source = `${meta.sheet.name} ${cellRef(m.clientCol, metaRow)}`;
      if (isBlank(raw)) {
        if (m.mandatory) {
          request.sheet.highlight(m.templateCol, tRow);
          meta.sheet.highlight(m.clientCol, metaRow);
          issueRows.add(metaRow);
          flag({
            kind: "mandatory",
            workbook: "template",
            sheet: request.sheet.name,
            cell: tCell,
            column: m.template,
            value: "",
            message: `Mandatory value missing (${source}).`,
          });
        }
        continue;
      }
      const value: CellValue =
        typeof raw === "number" && isDateHeader(m.template) ? excelSerialToIso(raw) : raw;
      if (!m.options) {
        request.sheet.set(m.templateCol, tRow, value);
        continue;
      }
      const text = String(value);
      const ok = m.options.includes(text);
      const corrected = !ok && m.fuzzy ? suggestOption(text, m.options) : undefined;
      if (corrected) {
        request.sheet.set(m.templateCol, tRow, corrected, { highlight: CORRECTED_RGB });
        meta.sheet.highlight(m.clientCol, metaRow, CORRECTED_RGB);
        flag({
          kind: "fuzzy",
          workbook: "template",
          sheet: request.sheet.name,
          cell: tCell,
          column: m.template,
          value: text,
          message: `Fuzzy-matched "${text}" to "${corrected}" (${source}).`,
          suggestion: corrected,
        });
        continue;
      }
      request.sheet.set(m.templateCol, tRow, text, { highlight: !ok });
      if (!ok) {
        meta.sheet.highlight(m.clientCol, metaRow);
        issueRows.add(metaRow);
        const suggestion = suggestOption(text, m.options);
        flag({
          kind: "dropdown",
          workbook: "template",
          sheet: request.sheet.name,
          cell: tCell,
          column: m.template,
          value: text,
          message: `Not a dropdown option (${source}).`,
          ...(suggestion ? { suggestion } : {}),
        });
      }
    }
  });

  // Contract Version: one row per Contract Request row.
  const signedDateCol = findColumn(meta, "Signed on date", "Signed On");
  for (const [col, header] of [
    [cv.signedCopy, "Is final signed copy?"],
    [cv.ai, "Is AI?"],
  ] as const) {
    const options = tpl.versionDropdowns.get(col);
    if (options && !options.includes("Yes")) {
      flag({
        kind: "version-dropdown",
        workbook: "template",
        sheet: version.sheet.name,
        cell: cellRef(col, version.headerRow + 1),
        column: header,
        value: "Yes",
        message: `"Yes" is not one of the dropdown options (${options.join(", ")}).`,
      });
    }
  }
  sourceRows.forEach((metaRow, i) => {
    const row = version.headerRow + 1 + i;
    version.sheet.set(cv.ref!, row, request.sheet.get(tpl.refCol, tpl.templateRows[i]!));
    const path = filePathByRow.get(metaRow) ?? null;
    version.sheet.set(cv.file!, row, path, { highlight: !path });
    if (!path) {
      issueRows.add(metaRow);
      flag({
        kind: "file-path",
        workbook: "template",
        sheet: version.sheet.name,
        cell: cellRef(cv.file!, row),
        column: "Contract Version file (with extension)",
        value: String(meta.sheet.get(input.fileNameCol, metaRow) ?? ""),
        message: "No file path found for this record.",
      });
    }
    version.sheet.set(cv.number!, row, 1);
    version.sheet.set(cv.signedCopy!, row, "Yes");
    version.sheet.set(cv.ai!, row, "Yes");
    if (cv.signedOn && signedDateCol) {
      const signed = meta.sheet.get(signedDateCol, metaRow);
      if (!isBlank(signed)) {
        const v = typeof signed === "number" ? excelSerialToIso(signed) : signed;
        version.sheet.set(cv.signedOn, row, v);
      }
    }
  });
  const supportingRows = fillSupporting(input, sourceRows, flag, issueRows);
  return { rows: sourceRows, flags, issueRows, supportingRows };
}

export async function run(files: PipelineFiles, opts: PipelineOptions): Promise<RunResult> {
  const c = await loadClient(files.client, opts);
  const { meta } = c;
  const flags: Flag[] = [];
  const metaName = meta.sheet.name;

  // 1. File Path tab built from "Files on SP".
  if (!c.filesSheet)
    throw new TransformError('No sheet with a "Folder Path" column found in the client workbook.');
  const filesSheetName = c.filesSheet;
  const entries = readFileEntries(readTable(c.wb.sheet(filesSheetName)), opts.prefix, opts.columns);
  for (const e of entries.filter((x) => !x.prefixFound)) {
    flags.push({
      kind: "prefix",
      workbook: "client",
      sheet: filesSheetName,
      cell: `row ${e.row}`,
      column: "Folder Path",
      value: e.folder,
      message: "Folder path does not contain the part to remove; kept in full.",
    });
  }
  const lookup = new PathLookup(entries);
  if (opts.includeClientWorkbook) {
    const pathSheet = c.wb.addOrReplaceSheet("File Path");
    pathSheet.set(1, 1, "File Name");
    pathSheet.set(2, 1, "File Path");
    entries.forEach((e, i) => {
      pathSheet.set(1, i + 2, e.name);
      pathSheet.set(2, i + 2, e.path);
    });
  }

  // 2. File Path column in Metadata Extraction, next to File Name (with extension).
  let pathCol = findColumn(meta, "File Path", "File Paths");
  let columnInserted = false;
  if (!pathCol) {
    meta.sheet.insertColumnAfter(c.fileNameCol);
    pathCol = c.fileNameCol + 1;
    meta.sheet.set(pathCol, meta.headerRow, "File Path", {
      style: meta.sheet.styleOf(c.fileNameCol, meta.headerRow),
    });
    columnInserted = true;
  }
  const filePathByRow = new Map<number, string>();
  // Per-document status for the dashboard: rows written, and rows with something to review.
  const writtenRows = new Set<number>();
  const attentionRows = new Set<number>();
  let duplicateNames = 0;
  for (const r of meta.dataRows) {
    const name = meta.sheet.get(c.fileNameCol, r);
    if (isBlank(name)) continue;
    const path = lookup.get(String(name));
    const style = meta.sheet.styleOf(c.fileNameCol, r);
    if (path) {
      filePathByRow.set(r, path);
      meta.sheet.set(pathCol, r, path, { style });
      // Upload batches repeat most files, so this is summarized rather than flagged per row.
      if (lookup.isDuplicate(String(name))) duplicateNames++;
    } else {
      meta.sheet.set(pathCol, r, null, { style });
      attentionRows.add(r);
      meta.sheet.highlight(pathCol, r);
      flags.push({
        kind: "file-path",
        workbook: "client",
        sheet: metaName,
        cell: cellRef(pathCol, r),
        column: "File Path",
        value: String(name),
        message: `File name not found on "${filesSheetName}".`,
      });
    }
  }
  // Column positions may have moved; re-read the header row.
  const metaTable = columnInserted ? readTable(meta.sheet) : meta;
  const appTypeCol = c.appTypeHeader
    ? keyColumn(metaTable, c.appTypeHeader, APP_TYPE_HEADERS)
    : null;

  // 3. Fill every template for its app type.
  const templates = await loadTemplates(
    files,
    metaTable.headers.map((h) => h.text),
    opts,
  );
  const auto = autoAppTypes(templates, c.appTypes, appTypeCol !== null);
  const filledBy = new Map<string, string>();
  // Supporting documents: parent row -> children, and where each parent was filled.
  const childrenOf = new Map<number, number[]>();
  for (const [child, parent] of c.links?.parentOf ?? [])
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
  const parentDocCol = c.parentDocHeader ? keyColumn(metaTable, c.parentDocHeader, []) : null;
  const placedSupporting = new Set<number>();
  const filledIn = new Map<number, string>();
  const results: TemplateRunResult[] = [];
  for (const t of templates) {
    const selection = opts.templates?.find((s) => s.index === t.index);
    const appTypes = selection ? selection.appTypes : (auto.get(t.index)?.appTypes ?? []);
    const base = {
      index: t.index,
      fileName: t.file.name,
      appTypes,
      rowsWritten: 0,
      supportingWritten: 0,
    };
    try {
      if (!t.ctx) throw new TransformError(t.error ?? "The template could not be read.");
      if (!appTypes.length)
        throw new TransformError("No application type was matched to this template.");
      const taken = appTypes.find((a) => filledBy.has(a));
      if (taken)
        throw new TransformError(`"${taken}" is already filled from ${filledBy.get(taken)}.`);
      const filled = fillTemplate({
        meta: metaTable,
        appTypeCol,
        fileNameCol: c.fileNameCol,
        tpl: t.ctx,
        templateName: t.file.name,
        appTypes,
        docTypeCol: c.docTypeHeader
          ? keyColumn(metaTable, c.docTypeHeader, DOC_TYPE_HEADERS)
          : null,
        mapping: selection?.mapping ?? t.ctx.auto.entries,
        filePathByRow,
        supporting: c.links ? { childrenOf, ambiguous: c.links.ambiguous, parentDocCol } : null,
      });
      flags.push(...filled.flags);
      for (const r of filled.rows) {
        writtenRows.add(r);
        filledIn.set(r, t.file.name);
      }
      for (const r of filled.supportingRows) {
        writtenRows.add(r);
        placedSupporting.add(r);
      }
      for (const r of filled.issueRows) attentionRows.add(r);
      for (const a of appTypes) filledBy.set(a, t.file.name);
      const output: OutputFile = {
        fileName: outputName(t.file.name, "filled"),
        base64: toBase64(await t.ctx.wb.save()),
      };
      results.push({
        ...base,
        status: "filled",
        rowsWritten: filled.rows.length,
        supportingWritten: filled.supportingRows.length,
        output,
      });
    } catch (e) {
      if (!(e instanceof TransformError)) throw e;
      results.push({ ...base, status: "skipped", error: e.message });
    }
  }

  // Supporting documents that did not go into any template.
  for (const r of c.links?.rows ?? []) {
    if (placedSupporting.has(r)) continue;
    attentionRows.add(r);
    const parentName = parentDocCol ? String(meta.sheet.get(parentDocCol, r) ?? "").trim() : "";
    const problem = c.links!.problem.get(r);
    const parent = c.links!.parentOf.get(r);
    const filledTemplate = parent !== undefined ? filledIn.get(parent) : undefined;
    if (parentDocCol) meta.sheet.highlight(parentDocCol, r);
    flags.push({
      kind: "supporting",
      workbook: "client",
      sheet: metaName,
      cell: cellRef(parentDocCol ?? c.fileNameCol, r),
      column: c.parentDocHeader ?? "Parent document",
      value: String(meta.sheet.get(c.fileNameCol, r) ?? ""),
      message:
        problem === "no-parent-name"
          ? "Supporting document without a parent document name."
          : problem === "parent-not-found"
            ? `No Parent-Main Agreement row has the file name "${parentName}".`
            : filledTemplate
              ? `Not written: ${filledTemplate} has no usable Supporting Document sheet.`
              : `Parent "${parentName}" was not filled into a template (its app type isn't chosen, or its template was skipped).`,
    });
  }

  // 4. Optionally, the client workbook with a Flags tab (the UI only downloads templates).
  let client: OutputFile | undefined;
  if (opts.includeClientWorkbook) {
    const flagSheet = c.wb.addOrReplaceSheet("Flags");
    ["Workbook", "Template", "Sheet", "Cell", "Column", "Value", "Issue", "Suggestion"].forEach(
      (h, i) => flagSheet.set(i + 1, 1, h),
    );
    flags.forEach((f, i) =>
      [
        f.workbook === "client" ? "Client data" : "Template",
        f.template ?? "",
        f.sheet,
        f.cell,
        f.column,
        f.value,
        f.message,
        f.suggestion ?? "",
      ].forEach((v, col) => flagSheet.set(col + 1, i + 2, v)),
    );
    client = {
      fileName: outputName(files.client.name, "transformed"),
      base64: toBase64(await c.wb.save()),
    };
  }

  const completed = [...writtenRows].filter((r) => !attentionRows.has(r)).length;

  return {
    templates: results,
    ...(client ? { client } : {}),
    flags,
    summary: {
      rowsWritten: results.reduce((n, r) => n + r.rowsWritten, 0),
      filePathsWritten: entries.length,
      columnInserted,
      duplicateNames,
      supportingWritten: placedSupporting.size,
      documents: {
        total: meta.dataRows.length,
        completed,
        needsAttention: attentionRows.size,
        pending: meta.dataRows.length - completed - attentionRows.size,
      },
    },
  };
}

/** Same as run() but with decoded bytes (used by tests). */
export async function runRaw(files: PipelineFiles, opts: PipelineOptions) {
  const result = await run(files, { includeClientWorkbook: true, ...opts });
  const decode = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
  return {
    ...result,
    clientBytes: decode(result.client!.base64),
    templateBytes: result.templates.map((t) => (t.output ? decode(t.output.base64) : null)),
  };
}
