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
    const guess = { fileName: null, appType: null, filesName: null, filesFolder: null };
    try {
      const table = readTable(wb.sheet(name));
      const text = (col: number | null) => table.headers.find((h) => h.col === col)?.text ?? null;
      const samples: Record<string, string> = {};
      for (const h of table.headers) {
        const row = table.dataRows.find((r) => !isBlank(table.sheet.get(h.col, r)));
        if (row !== undefined) samples[h.text] = display(table.sheet.get(h.col, row), h.text);
      }
      return {
        name,
        rows: table.dataRows.length,
        headers: table.headers.map((h) => h.text),
        samples,
        guess: {
          fileName: text(findColumn(table, ...FILE_NAME_HEADERS)),
          appType: text(findColumn(table, ...APP_TYPE_HEADERS)),
          filesName: text(findColumn(table, ...FILES_NAME_HEADERS)),
          filesFolder: text(findColumn(table, ...FOLDER_HEADERS)),
        },
      };
    } catch {
      return { name, rows: 0, headers: [], samples: {}, guess };
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
  const docTypeCol = findColumn(meta, ...DOC_TYPE_HEADERS);
  const docTypeHeader = meta.headers.find((h) => h.col === docTypeCol)?.text ?? null;

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
    requestRows,
    appTypes,
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
        t === pick && count ? { appTypes: [ALL_ROWS_APP_TYPE], score: 1 } : { appTypes: [], score: 0 },
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
};

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
  return { rows: sourceRows, flags, issueRows };
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
  const results: TemplateRunResult[] = [];
  for (const t of templates) {
    const selection = opts.templates?.find((s) => s.index === t.index);
    const appTypes = selection ? selection.appTypes : (auto.get(t.index)?.appTypes ?? []);
    const base = { index: t.index, fileName: t.file.name, appTypes, rowsWritten: 0 };
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
      });
      flags.push(...filled.flags);
      for (const r of filled.rows) writtenRows.add(r);
      for (const r of filled.issueRows) attentionRows.add(r);
      for (const a of appTypes) filledBy.set(a, t.file.name);
      const output: OutputFile = {
        fileName: outputName(t.file.name, "filled"),
        base64: toBase64(await t.ctx.wb.save()),
      };
      results.push({ ...base, status: "filled", rowsWritten: filled.rows.length, output });
    } catch (e) {
      if (!(e instanceof TransformError)) throw e;
      results.push({ ...base, status: "skipped", error: e.message });
    }
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
