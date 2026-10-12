// Types shared by the transformation server functions and the wizard UI.

export type MappingSource = "file" | "exact" | "alias" | "manual" | "none";

export type MappingEntry = {
  /** Header text in the template's Contract Request sheet. */
  template: string;
  /** Header text in the client's Metadata Extraction sheet, or null when unmapped. */
  client: string | null;
  source: MappingSource;
  mandatory: boolean;
  dropdown: boolean;
  /** Dropdown values that aren't an exact option are replaced by the closest option. */
  fuzzy: boolean;
  /** Template-owned columns (Batch Id, Record Reference Id) are never written. */
  reserved: boolean;
};

export type FlagKind =
  "dropdown" | "fuzzy" | "mandatory" | "file-path" | "prefix" | "version-dropdown" | "supporting";

export type Flag = {
  kind: FlagKind;
  /** Workbook the flagged cell lives in. */
  workbook: "client" | "template";
  sheet: string;
  cell: string;
  column: string;
  value: string;
  message: string;
  suggestion?: string;
  /** Template file the flag belongs to (template flags only). */
  template?: string;
};

export type AppTypeCount = {
  name: string;
  count: number;
  /** Name configured on the system, from the client's App Types sheet (e.g. "NDA"). */
  systemName: string | null;
};

export type FilePathPreview = { fileName: string; folder: string; filePath: string };

/** Sheets of the client workbook, with the ones detected as main data / SharePoint files. */
/** Header texts the user chose for the client's key columns. */
export type ClientColumns = {
  /** Main data sheet: file name with extension. */
  fileName?: string | undefined;
  /** Main data sheet: application type. */
  appType?: string | undefined;
  /** SharePoint files sheet: file name. */
  filesName?: string | undefined;
  /** SharePoint files sheet: folder path. */
  filesFolder?: string | undefined;
  /** Main data sheet: document type (Parent-Main Agreement, Supporting Documents, ...). */
  docType?: string | undefined;
  /** Main data sheet: file name of the parent document (supporting documents only). */
  parentDoc?: string | undefined;
};

/** Parent-child linkage: supporting documents go to their parent's Supporting Document sheet. */
export type SupportingDocsOptions = {
  /** Doc Type values that mark a supporting document. */
  types: string[];
};

/** How the supporting documents link to their parents (analysis preview). */
export type SupportingSummary = {
  total: number;
  /** Parent found among the Contract Request (Parent-Main Agreement) rows. */
  linked: number;
  noParentName: number;
  /** No Contract Request row has that file name. */
  parentNotFound: number;
  /** Several Contract Request rows have that file name; the first is used. */
  ambiguousParent: number;
  /** Linked supporting documents per parent app type. */
  byAppType: Record<string, number>;
};

export type SheetInfo = {
  name: string;
  rows: number;
  headers: string[];
  /** First non-empty value per header, shown next to the mapping. */
  samples: Record<string, string>;
  /** Distinct values of headers with only a few of them (e.g. Doc Type). */
  values: Record<string, string[]>;
  /** Likely key columns on this sheet (header texts), or null when none looks right. */
  guess: { [K in keyof ClientColumns]-?: string | null };
};

export type ClientSheets = {
  sheets: SheetInfo[];
  metadataSheet: string | null;
  filesSheet: string | null;
};

/** A template's Contract Request headers and its proposed column mapping. */
export type TemplateColumns = {
  /** Position of the template in the upload; used to refer to it in later calls. */
  index: number;
  fileName: string;
  /** App type name derived from the file name, e.g. "NDA_Aug_20.xlsx" → "NDA". */
  label: string;
  requestHeaders: string[];
  dropdownColumns: string[];
  mapping: MappingEntry[];
  mappingFileWarnings: string[];
  /** Set when the file isn't a usable template; it is then skipped. */
  error?: string;
};

export type TemplateAnalysis = TemplateColumns & {
  /** Client app type(s) the template matched to; empty when nothing matched well. */
  appTypes: string[];
  /** 0–1 confidence of the automatic match. */
  matchScore: number;
  templateRows: number;
};

export type AnalysisResult = {
  client: {
    fileName: string;
    sheets: string[];
    filesSheet: string | null;
    metadataSheet: string | null;
    metadataHeaders: string[];
    /** Application type column, or null when the sheet has none (all rows form one group). */
    appTypeColumn: string | null;
    /** Doc Type column used to keep only Parent-Main Agreement rows, if the sheet has one. */
    docTypeColumn: string | null;
    totalRows: number;
    /** Rows that go into Contract Request (Parent-Main Agreement rows, or all rows). */
    requestRows: number;
    /** Counts are of Contract Request rows only. */
    appTypes: AppTypeCount[];
    /** Present when supporting documents are linked to their parents. */
    supporting?: SupportingSummary | undefined;
  };
  templates: TemplateAnalysis[];
  filePaths: {
    total: number;
    missingPrefix: number;
    preview: FilePathPreview[];
    metadataUnmatched: number;
    /** Metadata file names found in more than one folder (the first listed folder is used). */
    duplicateNames: number;
  };
  /** First non-empty value per Metadata Extraction column, per app type. */
  samples: Record<string, Record<string, string>>;
};

/** What the user chose for one uploaded template. */
export type TemplateSelection = { index: number; appTypes: string[]; mapping: MappingEntry[] };

export type OutputFile = { fileName: string; base64: string };

export type TemplateRunResult = {
  index: number;
  fileName: string;
  appTypes: string[];
  status: "filled" | "skipped";
  /** Why the template was skipped. */
  error?: string;
  rowsWritten: number;
  /** Supporting Document rows written (when linking supporting documents). */
  supportingWritten: number;
  output?: OutputFile;
};

export type RunResult = {
  templates: TemplateRunResult[];
  /** The client workbook with File Path tab, highlights and Flags tab; only when asked for. */
  client?: OutputFile;
  flags: Flag[];
  summary: {
    rowsWritten: number;
    filePathsWritten: number;
    columnInserted: boolean;
    duplicateNames: number;
    /** Supporting Document rows written across the filled templates. */
    supportingWritten: number;
    /** Per document (row of the working sheet) after this run. */
    documents: {
      total: number;
      /** Written into a filled template with no issue to review. */
      completed: number;
      /** Rows with an issue: dropdown mismatch, missing mandatory value or no file path. */
      needsAttention: number;
      /** Not migrated yet: amendments, renewals, supporting docs, or skipped templates. */
      pending: number;
    };
  };
};

/** App type name used for every row when the main data sheet has no application type column. */
export const ALL_ROWS_APP_TYPE = "All rows";

/** Everything up to and including this part of the SharePoint folder path is removed. */
export const DEFAULT_PREFIX = "LegacyMigration/";

export const DEFAULT_MANDATORY = [
  "Party Name",
  "Party Type",
  "Address Line 1",
  "Country",
  "Assignee",
  "Legal Party",
];

/** Dropdown columns where values must match exactly (fuzzy matching is off by default). */
export const FUZZY_EXCLUDED = ["Party Name", "Legal Party"];

export const RESERVED_TEMPLATE_COLUMNS = ["Batch Id", "Record Reference Id"];
