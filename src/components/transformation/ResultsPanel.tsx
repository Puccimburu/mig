import { useMemo, useState } from "react";
import { ArrowDownToLine, ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";

import { useActivity } from "@/components/activity";
import { Button } from "@/components/ui/button";
import type { FlagKind, OutputFile, RunResult } from "@/lib/transform/types";
import { downloadBlob, Metric } from "./parts";

const KIND_LABEL: Record<FlagKind, string> = {
  dropdown: "Dropdown mismatch",
  fuzzy: "Fuzzy-corrected",
  mandatory: "Missing mandatory value",
  "file-path": "File path not found",
  prefix: "Prefix not found",
  "version-dropdown": "Contract Version dropdown",
};

/** Rows shown before "Show more"; after it the table is paginated. */
const PREVIEW_ROWS = 5;
const PAGE_SIZE = 25;

function bytesOf(file: OutputFile): Uint8Array<ArrayBuffer> {
  const bin = atob(file.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function download(file: OutputFile) {
  const type = /\.xlsm$/i.test(file.fileName)
    ? "application/vnd.ms-excel.sheet.macroEnabled.12"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  downloadBlob(new Blob([bytesOf(file)], { type }), file.fileName);
}

async function downloadAll(files: OutputFile[]) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const f of files) zip.file(f.fileName, bytesOf(f));
  downloadBlob(await zip.generateAsync({ type: "blob" }), "transformation-results.zip");
}

export function ResultsPanel({ result }: { result: RunResult }) {
  const { log } = useActivity();
  const downloadLogged = (files: OutputFile[]) => {
    if (files.length === 1) download(files[0]!);
    else void downloadAll(files);
    log({
      title: files.length === 1 ? "Filled template downloaded" : "Filled templates downloaded",
      detail: files.map((f) => f.fileName).join(", "),
      tone: "success",
    });
  };
  const [kind, setKind] = useState<FlagKind | "all">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const counts = useMemo(() => {
    const c = new Map<FlagKind, number>();
    for (const f of result.flags) c.set(f.kind, (c.get(f.kind) ?? 0) + 1);
    return c;
  }, [result.flags]);
  const visible = result.flags.filter(
    (f) =>
      (kind === "all" || f.kind === kind) &&
      `${f.template ?? ""} ${f.sheet} ${f.cell} ${f.column} ${f.value} ${f.suggestion ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = expanded
    ? visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
    : visible.slice(0, PREVIEW_ROWS);
  const fuzzy = counts.get("fuzzy") ?? 0;
  // Only the filled bulk import templates are downloaded.
  const outputs = result.templates.flatMap((t) => (t.output ? [t.output] : []));

  function filter(next: { kind?: FlagKind | "all"; query?: string }) {
    if (next.kind !== undefined) setKind(next.kind);
    if (next.query !== undefined) setQuery(next.query);
    setPage(0);
  }

  return (
    <>
      <div className="transform-summary">
        <Metric
          label="Contract Request rows"
          value={result.summary.rowsWritten}
          tone="success"
          note={`Across ${result.templates.filter((t) => t.status === "filled").length} templates`}
        />
        <Metric
          label="File paths built"
          value={result.summary.filePathsWritten}
          tone="success"
          note="Used for Contract Version files"
        />
        <Metric
          label="Fuzzy-corrected values"
          value={fuzzy}
          note="Highlighted blue in the template"
        />
        <Metric
          label="Issues to review"
          value={result.flags.length - fuzzy}
          tone={result.flags.length - fuzzy ? "warning" : "success"}
          note="Highlighted amber in the template"
        />
      </div>

      <div className="table-overflow">
        <table className="document-table transform-table">
          <thead>
            <tr>
              <th>Filled template</th>
              <th>Application type</th>
              <th>Rows</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {result.templates.map((t) => (
              <tr key={t.index}>
                <td>
                  <strong className="transform-col-name">{t.output?.fileName ?? t.fileName}</strong>
                </td>
                <td className="transform-sample">
                  {t.appTypes.length ? t.appTypes.join(", ") : "—"}
                </td>
                <td>{t.status === "filled" ? t.rowsWritten : "—"}</td>
                <td>
                  {t.status === "filled" ? (
                    <span className="badge tone-success">
                      <i />
                      Filled
                    </span>
                  ) : (
                    <span className="badge tone-warning transform-wrap">
                      <i />
                      Skipped: {t.error}
                    </span>
                  )}
                </td>
                <td>
                  {t.output && (
                    <Button variant="ghost" size="sm" onClick={() => downloadLogged([t.output!])}>
                      <ArrowDownToLine />
                      Download
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {outputs.length > 0 && (
        <div className="transform-actions transform-actions-start">
          {outputs.length === 1 ? (
            <Button onClick={() => downloadLogged(outputs)}>
              <ArrowDownToLine />
              Download filled template
            </Button>
          ) : (
            <Button onClick={() => downloadLogged(outputs)}>
              <ArrowDownToLine />
              Download all {outputs.length} filled templates (.zip)
            </Button>
          )}
        </div>
      )}

      {result.flags.length > 0 && (
        <div className="table-section">
          <div className="table-tools">
            <div className="tabs" role="tablist" aria-label="Flag type">
              {(["all", ...counts.keys()] as const).map((k) => (
                <Button
                  key={k}
                  variant="ghost"
                  role="tab"
                  aria-selected={k === kind}
                  className={`tab ${k === kind ? "active" : ""}`}
                  onClick={() => filter({ kind: k })}
                >
                  {k === "all"
                    ? `All (${result.flags.length})`
                    : `${KIND_LABEL[k]} (${counts.get(k)})`}
                </Button>
              ))}
            </div>
            <div className="filters">
              <div className="search-box">
                <Search />
                <input
                  placeholder="Search flags..."
                  aria-label="Search flags"
                  value={query}
                  onChange={(e) => filter({ query: e.target.value })}
                />
              </div>
            </div>
          </div>
          <div className="table-overflow">
            <table className="document-table transform-table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Sheet</th>
                  <th>Cell</th>
                  <th>Column</th>
                  <th>Value</th>
                  <th>Issue</th>
                  <th>Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f, i) => (
                  <tr key={`${f.template}-${f.sheet}-${f.cell}-${f.kind}-${i}`}>
                    <td className="transform-sample">{f.template ?? "Client data"}</td>
                    <td>{f.sheet}</td>
                    <td className="request-id">{f.cell}</td>
                    <td>{f.column}</td>
                    <td className="transform-sample">{f.value || "—"}</td>
                    <td className="transform-sample">{f.message}</td>
                    <td>{f.suggestion ?? ""}</td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={7} className="text-center text-muted-foreground h-24">
                      No flags match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!expanded && visible.length > PREVIEW_ROWS && (
            <div className="transform-actions transform-actions-start">
              <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                <ChevronDown />
                Show more ({visible.length - PREVIEW_ROWS} more)
              </Button>
            </div>
          )}
          {expanded && visible.length > 0 && (
            <div className="table-footer">
              <span>
                Showing {current * PAGE_SIZE + 1}–
                {Math.min((current + 1) * PAGE_SIZE, visible.length)} of {visible.length}
              </span>
              <div className="pagination">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous page"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  <ChevronLeft />
                </Button>
                <span className="transform-page">
                  Page {current + 1} of {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next page"
                  disabled={current >= pages - 1}
                  onClick={() => setPage(current + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
