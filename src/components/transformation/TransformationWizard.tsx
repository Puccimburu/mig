import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Play,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";

import { useActivity } from "@/components/activity";
import { Button } from "@/components/ui/button";
import {
  analyzeTransformation,
  inspectClientWorkbook,
  inspectTemplateColumns,
  runTransformation,
} from "@/lib/transform/functions";
import type {
  AnalysisResult,
  ClientSheets,
  MappingEntry,
  RunResult,
  SupportingSummary,
  TemplateColumns,
} from "@/lib/transform/types";
import { ALL_ROWS_APP_TYPE, DEFAULT_PREFIX } from "@/lib/transform/types";
import { MappingTable } from "./MappingTable";
import { FileSlot, Metric, Step } from "./parts";
import { ResultsPanel } from "./ResultsPanel";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Contract Request rows of the chosen app types. */
function rowCount(analysis: AnalysisResult, types: string[]): number {
  return analysis.client.appTypes
    .filter((a) => types.includes(a.name))
    .reduce((n, a) => n + a.count, 0);
}

/** Why a template can't be filled with the current choices, or null when it's ready. */
function blocker(
  t: TemplateColumns,
  analysis: AnalysisResult,
  appTypes: Record<number, string[]>,
  mapping: MappingEntry[],
): string | null {
  if (t.error) return t.error;
  const chosen = appTypes[t.index] ?? [];
  if (!chosen.length) return "Choose an application type";
  const owner = analysis.templates.find(
    (o) =>
      o.index < t.index && !o.error && (appTypes[o.index] ?? []).some((x) => chosen.includes(x)),
  );
  if (owner) return `App type also chosen for ${owner.fileName}`;
  const count = rowCount(analysis, chosen);
  const rows = analysis.templates.find((o) => o.index === t.index)?.templateRows ?? 0;
  if (count !== rows) return `${count} client rows vs ${rows} template rows`;
  const missing = mapping.filter((m) => m.mandatory && !m.reserved && !m.client);
  if (missing.length) return `Map ${missing.map((m) => m.template).join(", ")}`;
  return null;
}

export function TransformationWizard() {
  const [client, setClient] = useState<File | null>(null);
  const [templates, setTemplates] = useState<File[]>([]);
  const [mappingFile, setMappingFile] = useState<File | null>(null);
  const [prefix, setPrefix] = useState(DEFAULT_PREFIX);
  const [clientSheets, setClientSheets] = useState<ClientSheets | null>(null);
  const [metadataSheet, setMetadataSheet] = useState("");
  const [fileNameColumn, setFileNameColumn] = useState("");
  // Sheet listing the SharePoint files: file name + folder path build each File Path.
  const [filesSheet, setFilesSheet] = useState("");
  const [filesNameColumn, setFilesNameColumn] = useState("");
  const [filesFolderColumn, setFilesFolderColumn] = useState("");
  // Parent-child linkage of supporting documents.
  const [linkSupporting, setLinkSupporting] = useState(false);
  const [docTypeColumn, setDocTypeColumn] = useState("");
  const [parentDocColumn, setParentDocColumn] = useState("");
  const [supportingTypes, setSupportingTypes] = useState<string[]>([]);
  const [templateColumns, setTemplateColumns] = useState<TemplateColumns[] | null>(null);
  const [mappings, setMappings] = useState<Record<number, MappingEntry[]>>({});
  const [activeTemplate, setActiveTemplate] = useState(0);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [appTypes, setAppTypes] = useState<Record<number, string[]>>({});
  const [showPaths, setShowPaths] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<"inspect" | "columns" | "analyze" | "run" | null>(null);
  const [error, setError] = useState("");
  const columnsRequest = useRef(0);
  const { log, recordSnapshot } = useActivity();

  const sheet = clientSheets?.sheets.find((s) => s.name === metadataSheet);
  const pathsSheet = clientSheets?.sheets.find((s) => s.name === filesSheet);
  const pathsReady = Boolean(pathsSheet && filesNameColumn && filesFolderColumn);
  const docTypeValues = (sheet && docTypeColumn && sheet.values[docTypeColumn]) || [];
  const linkReady =
    !linkSupporting || Boolean(docTypeColumn && parentDocColumn && supportingTypes.length);

  // Load the template headers and proposed mapping as soon as the working sheet is known.
  useEffect(() => {
    setTemplateColumns(null);
    setMappings({});
    setAnalysis(null);
    setResult(null);
    if (!sheet || !templates.length) return;
    const request = ++columnsRequest.current;
    const fd = new FormData();
    for (const t of templates) fd.append("template", t);
    if (mappingFile) fd.append("mappingFile", mappingFile);
    fd.append("options", JSON.stringify({ clientHeaders: sheet.headers }));
    setBusy("columns");
    inspectTemplateColumns({ data: fd })
      .then((cols) => {
        if (request !== columnsRequest.current) return;
        setTemplateColumns(cols);
        setMappings(Object.fromEntries(cols.map((c) => [c.index, c.mapping])));
        setActiveTemplate(cols.find((c) => !c.error)?.index ?? 0);
      })
      .catch((e: unknown) => {
        if (request === columnsRequest.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (request === columnsRequest.current) setBusy(null);
      });
  }, [sheet, templates, mappingFile]);

  async function chooseClient(file: File | null) {
    setClient(file);
    setClientSheets(null);
    setMetadataSheet("");
    setFileNameColumn("");
    setFilesSheet("");
    setFilesNameColumn("");
    setFilesFolderColumn("");
    setError("");
    if (!file) return;
    setBusy("inspect");
    try {
      const fd = new FormData();
      fd.append("client", file);
      const sheets = await inspectClientWorkbook({ data: fd });
      setClientSheets(sheets);
      chooseSheet(sheets, sheets.metadataSheet ?? "");
      chooseFilesSheet(sheets, sheets.filesSheet ?? "");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function chooseSheet(sheets: ClientSheets, name: string) {
    const info = sheets.sheets.find((s) => s.name === name);
    setMetadataSheet(name);
    setFileNameColumn(info?.guess.fileName ?? "");
    setParentDocColumn(info?.guess.parentDoc ?? "");
    chooseDocTypeColumn(info, info?.guess.docType ?? "");
  }

  /** Doc type column, with the values containing "support" ticked as supporting documents. */
  function chooseDocTypeColumn(info: ClientSheets["sheets"][number] | undefined, column: string) {
    setDocTypeColumn(column);
    setSupportingTypes((info?.values[column] ?? []).filter((v) => /support/i.test(v)));
    setAnalysis(null);
    setResult(null);
  }

  function chooseFilesSheet(sheets: ClientSheets, name: string) {
    const guess = sheets.sheets.find((s) => s.name === name)?.guess;
    setFilesSheet(name);
    setFilesNameColumn(guess?.filesName ?? "");
    setFilesFolderColumn(guess?.filesFolder ?? "");
    setAnalysis(null);
    setResult(null);
  }

  function formData(withChoices: boolean) {
    const fd = new FormData();
    if (client) fd.append("client", client);
    for (const t of templates) fd.append("template", t);
    if (mappingFile) fd.append("mappingFile", mappingFile);
    const choices = withChoices
      ? (templateColumns ?? []).map((t) => ({
          index: t.index,
          appTypes: appTypes[t.index] ?? [],
          mapping: mappings[t.index] ?? t.mapping,
        }))
      : undefined;
    fd.append(
      "options",
      JSON.stringify({
        prefix,
        metadataSheet,
        filesSheet: filesSheet || undefined,
        columns: {
          fileName: fileNameColumn,
          filesName: filesNameColumn || undefined,
          filesFolder: filesFolderColumn || undefined,
          ...(linkSupporting
            ? { docType: docTypeColumn || undefined, parentDoc: parentDocColumn || undefined }
            : {}),
        },
        supportingDocs: linkSupporting ? { types: supportingTypes } : undefined,
        templates: choices,
      }),
    );
    return fd;
  }

  async function analyze() {
    setBusy("analyze");
    setError("");
    setResult(null);
    try {
      const a = await analyzeTransformation({ data: formData(false) });
      setAnalysis(a);
      setAppTypes(Object.fromEntries(a.templates.map((t) => [t.index, t.appTypes])));
      setShowPaths(false);
      const matched = a.templates.filter((t) => t.appTypes.length).length;
      log({
        title: "Transformation files analyzed",
        detail: `${a.client.fileName} (${a.client.metadataSheet}) · ${a.client.requestRows} contract rows · ${matched} of ${a.templates.length} templates matched to app types`,
        tone: "info",
      });
    } catch (e) {
      setError(errorMessage(e));
      log({ title: "Transformation analysis failed", detail: errorMessage(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    setBusy("run");
    setError("");
    try {
      const r = await runTransformation({ data: formData(true) });
      setResult(r);
      const filled = r.templates.filter((t) => t.status === "filled");
      recordSnapshot({
        ...r.summary.documents,
        at: Date.now(),
        clientFile: client?.name ?? "",
        sheet: metadataSheet,
        templatesFilled: filled.length,
        templatesTotal: r.templates.length,
      });
      const fuzzy = r.flags.filter((f) => f.kind === "fuzzy").length;
      const issues = r.flags.length - fuzzy;
      log({
        title: filled.length ? "Transformation completed" : "Transformation filled no templates",
        detail: [
          `${filled.length} of ${r.templates.length} templates filled (${filled.map((t) => t.fileName).join(", ") || "none"})`,
          `${r.summary.rowsWritten} Contract Request rows`,
          `${fuzzy} fuzzy-corrected`,
          `${issues} issues to review`,
        ].join(" · "),
        tone: !filled.length
          ? "danger"
          : issues || filled.length < r.templates.length
            ? "warning"
            : "success",
      });
    } catch (e) {
      setError(errorMessage(e));
      log({ title: "Transformation failed", detail: errorMessage(e), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const usable = templateColumns?.filter((t) => !t.error) ?? [];
  const active = usable.find((t) => t.index === activeTemplate) ?? usable[0];
  const activeMapping = active ? mappings[active.index] : undefined;
  const blockers = analysis
    ? Object.fromEntries(
        (templateColumns ?? []).map((t) => [
          t.index,
          blocker(t, analysis, appTypes, mappings[t.index] ?? t.mapping),
        ]),
      )
    : {};
  const readyCount = templateColumns
    ? templateColumns.filter((t) => analysis && !blockers[t.index]).length
    : 0;
  const unmappedMandatory = (index: number) =>
    (mappings[index] ?? []).filter((m) => m.mandatory && !m.reserved && !m.client);

  return (
    <div className="transform-wizard">
      <Step
        number={1}
        title="Upload workbooks"
        aside="Files are processed on the server and returned to you"
      >
        <div className="transform-slots">
          <FileSlot
            title="Client data workbook"
            hint="You pick its working sheet next"
            accept=".xlsx,.xlsm"
            files={client ? [client] : []}
            onAdd={(f) => void chooseClient(f[0] ?? null)}
            onRemove={() => void chooseClient(null)}
          />
          <FileSlot
            title="Bulk import templates"
            hint="One per app type · named after it, e.g. NDA_Aug_20.xlsx"
            accept=".xlsx,.xlsm"
            multiple
            files={templates}
            onAdd={(f) =>
              setTemplates((t) => [
                ...t,
                ...f.filter((n) => !t.some((o) => o.name === n.name && o.size === n.size)),
              ])
            }
            onRemove={(i) => setTemplates((t) => t.filter((_, j) => j !== i))}
          />
          <FileSlot
            title="Column mapping file"
            hint="Optional · 2 columns: Client Column, Template Column"
            accept=".csv,.xlsx"
            files={mappingFile ? [mappingFile] : []}
            onAdd={(f) => setMappingFile(f[0] ?? null)}
            onRemove={() => setMappingFile(null)}
          />
        </div>
        {busy === "inspect" && (
          <p className="transform-note">
            <LoaderCircle size={12} className="inline animate-spin" /> Reading the client workbook's
            sheets…
          </p>
        )}
        {clientSheets && (
          <div className="transform-picker transform-sheet-pickers">
            <label className="transform-field">
              <span>
                <strong>Working sheet</strong> · one row per document
              </span>
              <select
                value={metadataSheet}
                onChange={(e) => chooseSheet(clientSheets, e.target.value)}
              >
                <option value="">— Choose a sheet —</option>
                {clientSheets.sheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.rows} rows)
                  </option>
                ))}
              </select>
            </label>
            {sheet && (
              <label className="transform-field">
                <span>File name column (with extension)</span>
                <select
                  value={fileNameColumn}
                  className={fileNameColumn ? "" : "transform-missing"}
                  onChange={(e) => {
                    setFileNameColumn(e.target.value);
                    setAnalysis(null);
                    setResult(null);
                  }}
                >
                  <option value="">— Choose a column —</option>
                  {sheet.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {clientSheets && (
          <div className="transform-picker transform-sheet-pickers transform-paths-picker">
            <label className="transform-field">
              <span>
                <strong>File path sheet</strong> · SharePoint files with their folder
              </span>
              <select
                value={filesSheet}
                className={filesSheet ? "" : "transform-missing"}
                onChange={(e) => chooseFilesSheet(clientSheets, e.target.value)}
              >
                <option value="">— Choose a sheet —</option>
                {clientSheets.sheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.rows} rows)
                  </option>
                ))}
              </select>
            </label>
            {pathsSheet && (
              <>
                <label className="transform-field">
                  <span>File name column</span>
                  <select
                    value={filesNameColumn}
                    className={filesNameColumn ? "" : "transform-missing"}
                    onChange={(e) => {
                      setFilesNameColumn(e.target.value);
                      setAnalysis(null);
                      setResult(null);
                    }}
                  >
                    <option value="">— Choose a column —</option>
                    {pathsSheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                        {pathsSheet.samples[h] ? ` · e.g. ${pathsSheet.samples[h]}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="transform-field">
                  <span>Folder path column</span>
                  <select
                    value={filesFolderColumn}
                    className={filesFolderColumn ? "" : "transform-missing"}
                    onChange={(e) => {
                      setFilesFolderColumn(e.target.value);
                      setAnalysis(null);
                      setResult(null);
                    }}
                  >
                    <option value="">— Choose a column —</option>
                    {pathsSheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                        {pathsSheet.samples[h] ? ` · e.g. ${pathsSheet.samples[h]}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {filesSheet && filesSheet === metadataSheet && (
              <p className="transform-warning">
                <TriangleAlert size={13} /> This is also the working sheet. Usually the file paths
                are on a separate sheet such as “Files on SP”.
              </p>
            )}
          </div>
        )}
        {sheet && (
          <div className="transform-picker transform-linkage">
            <label className="request-id-check">
              <input
                type="checkbox"
                checked={linkSupporting}
                onChange={(e) => {
                  setLinkSupporting(e.target.checked);
                  setAnalysis(null);
                  setResult(null);
                }}
              />
              <strong>Link supporting documents to their parents</strong>
            </label>
            <small className="transform-note">
              Each supporting document goes into the Supporting Document sheet of its parent's
              template, under the parent's Record Reference Id.
            </small>
            {linkSupporting && (
              <div className="transform-sheet-pickers transform-paths-picker">
                <label className="transform-field">
                  <span>Doc type column</span>
                  <select
                    value={docTypeColumn}
                    className={docTypeColumn ? "" : "transform-missing"}
                    onChange={(e) => chooseDocTypeColumn(sheet, e.target.value)}
                  >
                    <option value="">— Choose a column —</option>
                    {sheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="transform-field">
                  <span>Parent document column · the parent's file name</span>
                  <select
                    value={parentDocColumn}
                    className={parentDocColumn ? "" : "transform-missing"}
                    onChange={(e) => {
                      setParentDocColumn(e.target.value);
                      setAnalysis(null);
                      setResult(null);
                    }}
                  >
                    <option value="">— Choose a column —</option>
                    {sheet.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
                {docTypeColumn && (
                  <fieldset className="name-check-columns transform-linkage-types">
                    <legend>Doc types that are supporting documents</legend>
                    {docTypeValues.map((v) => (
                      <label key={v} className="request-id-check">
                        <input
                          type="checkbox"
                          checked={supportingTypes.includes(v)}
                          onChange={() => {
                            setSupportingTypes((all) =>
                              all.includes(v) ? all.filter((x) => x !== v) : [...all, v],
                            );
                            setAnalysis(null);
                            setResult(null);
                          }}
                        />
                        {v}
                      </label>
                    ))}
                    {!docTypeValues.length && (
                      <p className="transform-warning">
                        <TriangleAlert size={13} /> “{docTypeColumn}” has too many different values
                        to list. Choose the doc type column.
                      </p>
                    )}
                  </fieldset>
                )}
              </div>
            )}
          </div>
        )}
        <label className="transform-field">
          <span>Remove the folder path up to and including</span>
          <input
            value={prefix}
            onChange={(e) => {
              setPrefix(e.target.value);
              setAnalysis(null);
              setResult(null);
            }}
            spellCheck={false}
          />
        </label>
      </Step>

      {error && (
        <div className="notice transform-error" role="alert">
          <span>
            <TriangleAlert size={14} /> {error}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X />
          </Button>
        </div>
      )}

      {sheet && templates.length > 0 && (
        <Step
          number={2}
          title="Map columns"
          aside={
            active && activeMapping
              ? `${activeMapping.filter((m) => m.client).length} of ${
                  activeMapping.filter((m) => !m.reserved).length
                } template columns mapped in ${active.fileName}`
              : undefined
          }
        >
          {busy === "columns" && (
            <p className="transform-note">
              <LoaderCircle size={12} className="inline animate-spin" /> Reading the template
              headers…
            </p>
          )}
          {templateColumns
            ?.filter((t) => t.error)
            .map((t) => (
              <p key={t.index} className="transform-warning">
                <TriangleAlert size={13} /> {t.fileName}: {t.error} It will be skipped.
              </p>
            ))}
          {active && activeMapping && (
            <>
              {usable.length > 1 && (
                <div className="tabs transform-template-tabs" role="tablist" aria-label="Template">
                  {usable.map((t) => (
                    <Button
                      key={t.index}
                      variant="ghost"
                      role="tab"
                      aria-selected={t.index === active.index}
                      className={`tab ${t.index === active.index ? "active" : ""}`}
                      onClick={() => setActiveTemplate(t.index)}
                    >
                      {t.label}
                      {unmappedMandatory(t.index).length > 0 && (
                        <TriangleAlert size={12} className="text-warning" />
                      )}
                    </Button>
                  ))}
                </div>
              )}
              {active.mappingFileWarnings.map((w) => (
                <p key={w} className="transform-warning">
                  <TriangleAlert size={13} /> {w}
                </p>
              ))}
              <MappingTable
                mapping={activeMapping}
                clientHeaders={sheet.headers}
                clientSheet={sheet.name}
                samples={sheet.samples}
                onChange={(m) => setMappings((all) => ({ ...all, [active.index]: m }))}
              />
              <div className="transform-actions">
                <Button
                  variant="outline"
                  onClick={() => setMappings((all) => ({ ...all, [active.index]: active.mapping }))}
                >
                  <RotateCcw />
                  Reset this template
                </Button>
              </div>
              {unmappedMandatory(active.index).length > 0 && (
                <p className="transform-warning">
                  <TriangleAlert size={13} /> Map the mandatory columns:{" "}
                  {unmappedMandatory(active.index)
                    .map((m) => m.template)
                    .join(", ")}
                  .
                </p>
              )}
            </>
          )}
        </Step>
      )}

      {templateColumns && usable.length > 0 && (
        <Step
          number={3}
          title="Analyze and match app types"
          aside={
            analysis ? `${readyCount} of ${templateColumns.length} templates ready` : undefined
          }
        >
          {!analysis && (
            <div className="transform-actions transform-actions-start">
              <Button
                disabled={!fileNameColumn || !pathsReady || !linkReady || busy !== null}
                onClick={analyze}
              >
                {busy === "analyze" ? <LoaderCircle className="animate-spin" /> : <Search />}
                Analyze files
              </Button>
              {!fileNameColumn && (
                <span className="transform-warning">
                  <TriangleAlert size={13} /> Choose the file name column in step 1.
                </span>
              )}
              {fileNameColumn && !pathsReady && (
                <span className="transform-warning">
                  <TriangleAlert size={13} /> Choose the file path sheet and its file name and
                  folder path columns in step 1.
                </span>
              )}
              {fileNameColumn && pathsReady && !linkReady && (
                <span className="transform-warning">
                  <TriangleAlert size={13} /> Choose the doc type column, the parent document column
                  and at least one supporting doc type in step 1.
                </span>
              )}
            </div>
          )}
          {analysis && (
            <>
              <div className="table-overflow">
                <table className="document-table transform-table">
                  <thead>
                    <tr>
                      <th>Template</th>
                      <th>Application type</th>
                      <th>Rows</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.templates.map((t) => {
                      const chosen = appTypes[t.index] ?? [];
                      const count = rowCount(analysis, chosen);
                      const problem = blockers[t.index];
                      return (
                        <tr key={t.index}>
                          <td>
                            <strong className="transform-col-name">{t.fileName}</strong>
                            <span className="transform-note">Read from name: “{t.label}”</span>
                          </td>
                          <td>
                            {t.error ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <AppTypePicker
                                fileName={t.fileName}
                                options={analysis.client.appTypes}
                                value={chosen}
                                onChange={(next) =>
                                  setAppTypes((all) => ({ ...all, [t.index]: next }))
                                }
                                note={
                                  t.appTypes.length > 0 && sameSet(chosen, t.appTypes)
                                    ? `Auto-matched · ${Math.round(t.matchScore * 100)}% confidence`
                                    : undefined
                                }
                              />
                            )}
                          </td>
                          <td>{t.error ? "—" : `${count} / ${t.templateRows}`}</td>
                          <td>
                            {problem ? (
                              <span className="badge tone-warning transform-wrap">
                                <i />
                                {problem}
                              </span>
                            ) : (
                              <span className="badge tone-success">
                                <i />
                                Ready
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <small className="transform-note">
                Rows shows {analysis.client.metadataSheet} rows for the chosen app types / Record
                Reference Ids in the template; they must be equal.{" "}
                {analysis.client.docTypeColumn
                  ? `Only Parent-Main Agreement rows count (${analysis.client.requestRows} of ${analysis.client.totalRows}, from “${analysis.client.docTypeColumn}”); amendments, renewals and supporting documents are not Contract Requests.`
                  : "The sheet has no Doc Type column, so every row counts."}
                {!analysis.client.appTypeColumn &&
                  ` The sheet has no application type column, so all rows go into one template (“${ALL_ROWS_APP_TYPE}”).`}
              </small>

              {analysis.client.supporting && (
                <SupportingPreview summary={analysis.client.supporting} />
              )}

              <div className="transform-summary transform-summary-spaced">
                <Metric
                  label="SharePoint files"
                  value={analysis.filePaths.total}
                  note={analysis.client.filesSheet ?? "—"}
                />
                <Metric
                  label="Documents without a path"
                  value={analysis.filePaths.metadataUnmatched}
                  tone={analysis.filePaths.metadataUnmatched ? "warning" : "success"}
                  note="Flagged in the output"
                />
                <Metric
                  label="Files in several folders"
                  value={analysis.filePaths.duplicateNames}
                  note="First listed folder is used"
                />
                <Metric
                  label="Folders without that part"
                  value={analysis.filePaths.missingPrefix}
                  tone={analysis.filePaths.missingPrefix ? "warning" : "success"}
                  note="Kept as they are"
                />
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowPaths((s) => !s)}>
                {showPaths ? <ChevronUp /> : <ChevronDown />}
                {showPaths ? "Hide file paths" : "See more"}
              </Button>
              {showPaths && (
                <>
                  <div className="table-overflow">
                    <table className="document-table transform-table">
                      <thead>
                        <tr>
                          <th>File name</th>
                          <th>File path</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.filePaths.preview.map((p, i) => (
                          <tr key={`${p.fileName}-${i}`}>
                            <td>{p.fileName}</td>
                            <td className="transform-path" title={p.folder}>
                              {p.filePath}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <small className="transform-note">
                    First {analysis.filePaths.preview.length} of {analysis.filePaths.total}. All
                    paths are on the File Path tab of the output workbook.
                  </small>
                </>
              )}

              <div className="transform-actions">
                <Button variant="outline" disabled={busy !== null} onClick={analyze}>
                  {busy === "analyze" ? <LoaderCircle className="animate-spin" /> : <Search />}
                  Analyze again
                </Button>
                <Button disabled={busy !== null || readyCount === 0} onClick={run}>
                  {busy === "run" ? <LoaderCircle className="animate-spin" /> : <Play />}
                  {readyCount === templateColumns.length
                    ? `Run all ${readyCount} templates`
                    : `Run ${readyCount} of ${templateColumns.length} templates`}
                </Button>
              </div>
              {readyCount < templateColumns.length && (
                <p className="transform-warning">
                  <TriangleAlert size={13} /> Templates that aren't ready are skipped; see Status
                  above.
                </p>
              )}
            </>
          )}
        </Step>
      )}

      {result && (
        <Step
          number={4}
          title="Download results"
          aside={`${result.templates.filter((t) => t.status === "filled").length} templates filled`}
        >
          <ResultsPanel result={result} />
        </Step>
      )}
    </div>
  );
}

function AppTypePicker({
  fileName,
  options,
  value,
  onChange,
  note,
}: {
  fileName: string;
  options: AnalysisResult["client"]["appTypes"];
  value: string[];
  onChange: (next: string[]) => void;
  note?: string | undefined;
}) {
  const remaining = options.filter((a) => !value.includes(a.name));
  return (
    <div className="transform-apptypes">
      {value.map((name) => (
        <span key={name} className="transform-chip">
          {name}
          <span className="text-muted-foreground">
            {" "}
            · {options.find((a) => a.name === name)?.count ?? 0}
          </span>
          <button
            type="button"
            aria-label={`Remove ${name} from ${fileName}`}
            onClick={() => onChange(value.filter((x) => x !== name))}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <select
          aria-label={`Add an application type to ${fileName}`}
          value=""
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        >
          <option value="">{value.length ? "+ Add app type" : "— Choose app type —"}</option>
          {remaining.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
              {a.systemName && a.systemName !== a.name ? ` (${a.systemName})` : ""} · {a.count} rows
            </option>
          ))}
        </select>
      )}
      {note && <span className="transform-note">{note}</span>}
    </div>
  );
}

function SupportingPreview({ summary }: { summary: SupportingSummary }) {
  const unlinked = summary.total - summary.linked;
  return (
    <>
      <div className="transform-summary transform-summary-spaced">
        <Metric
          label="Supporting documents"
          value={summary.total}
          note="Rows with a supporting doc type"
        />
        <Metric
          label="Linked to a parent"
          value={summary.linked}
          tone={summary.linked ? "success" : "neutral"}
          note={
            Object.entries(summary.byAppType)
              .map(([type, n]) => `${type}: ${n}`)
              .join(" · ") || "—"
          }
        />
        <Metric
          label="No parent name"
          value={summary.noParentName}
          tone={summary.noParentName ? "warning" : "success"}
          note="Parent document cell is empty"
        />
        <Metric
          label="Parent not found"
          value={summary.parentNotFound}
          tone={summary.parentNotFound ? "warning" : "success"}
          note="No Parent-Main Agreement has that file name"
        />
      </div>
      {(unlinked > 0 || summary.ambiguousParent > 0) && (
        <small className="transform-note">
          {unlinked > 0 && `${unlinked} supporting documents can't be linked and will be flagged. `}
          {summary.ambiguousParent > 0 &&
            `${summary.ambiguousParent} name a parent file that several agreements share; they go to the first and are flagged.`}
        </small>
      )}
    </>
  );
}
