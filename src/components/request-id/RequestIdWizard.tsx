import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";

import { useActivity } from "@/components/activity";
import { FileSlot, Metric, Step } from "@/components/transformation/parts";
import { Button } from "@/components/ui/button";
import {
  backendAvailable,
  cancelJob,
  getJob,
  getRecords,
  reportUrl,
  startJob,
  workbookUrl,
  type JobLog,
  type JobRecord,
  type JobView,
} from "@/lib/request-id/api";

const URL_KEY = "auto-migrate.clm-url";
const JOB_KEY = "auto-migrate.request-id-job";
const POLL_MS = 2000;
const MAX_LOG_LINES = 300;
const PREVIEW_ROWS = 5;
const PAGE_SIZE = 25;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Browser storage can be unavailable (private mode, blocked site data).
function stored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function store(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Only a convenience.
  }
}

function statusTone(status: string): string {
  if (status === "Completed") return "success";
  if (status === "Partially Completed") return "warning";
  if (status === "Failed") return "danger";
  return "neutral";
}

export function RequestIdWizard() {
  const [workbook, setWorkbook] = useState<File | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [uploadedOn, setUploadedOn] = useState("");
  const [totalCount, setTotalCount] = useState("");
  const [template, setTemplate] = useState("");
  const [supportingDocs, setSupportingDocs] = useState(true);
  const [showBrowser, setShowBrowser] = useState(true);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [records, setRecords] = useState<JobRecord[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const logCount = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  const { log } = useActivity();

  const running = job?.status === "running";

  async function checkBackend() {
    setBackendUp(null);
    setBackendUp(await backendAvailable());
  }

  // On load: remembered site URL, backend check, and a run still going from before a reload.
  useEffect(() => {
    setSiteUrl(stored(URL_KEY));
    void (async () => {
      const up = await backendAvailable();
      setBackendUp(up);
      const id = stored(JOB_KEY);
      if (!up || !id) return;
      try {
        const view = await getJob(id);
        logCount.current = view.logCount;
        setLogs(view.logs.slice(-MAX_LOG_LINES));
        setJob(view);
        if (view.status !== "running") setRecords(await getRecords(id));
      } catch {
        store(JOB_KEY, null);
      }
    })();
  }, []);

  // Poll the running job for new log lines and counters.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const id = job.id;
    const timer = window.setInterval(async () => {
      try {
        const view = await getJob(id, logCount.current);
        logCount.current = view.logCount;
        if (view.logs.length) setLogs((l) => [...l, ...view.logs].slice(-MAX_LOG_LINES));
        setJob(view);
        if (view.status !== "running") finished(view);
      } catch (e) {
        setError(errorMessage(e));
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs]);

  async function finished(view: JobView) {
    const c = view.counters;
    const detail = `${view.workbookName} · ${c.processed} filled · ${c.notReady} not ready · ${c.noMatch} not matched`;
    if (view.status === "done") {
      log({
        title: view.result?.fully_completed
          ? "Request IDs populated"
          : "Request IDs partially populated",
        detail,
        tone: view.result?.fully_completed ? "success" : "warning",
      });
    } else if (view.status === "cancelled") {
      log({ title: "Request ID run cancelled", detail, tone: "warning" });
    } else {
      log({
        title: "Request ID run failed",
        detail: view.result?.errors?.join("; ") || detail,
        tone: "danger",
      });
    }
    try {
      setRecords(await getRecords(view.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const missing = [
    !workbook && "the filled template",
    !siteUrl.trim() && "site URL",
    !username.trim() && "username",
    !password && "password",
    !uploadedOn.trim() && "Uploaded On",
    !totalCount.trim() && "total count",
  ].filter(Boolean) as string[];
  const countInvalid = totalCount.trim() !== "" && !/^\d+$/.test(totalCount.trim());

  async function start() {
    if (!workbook) return;
    setStarting(true);
    setError("");
    setRecords([]);
    setLogs([]);
    logCount.current = 0;
    store(URL_KEY, siteUrl.trim());
    try {
      const view = await startJob(workbook, {
        url: siteUrl.trim(),
        username: username.trim(),
        password,
        uploaded_on: uploadedOn.trim(),
        total_count: totalCount.trim(),
        template: template.trim(),
        supporting_docs: supportingDocs,
        headless: !showBrowser,
      });
      store(JOB_KEY, view.id);
      setJob(view);
      log({
        title: "Request ID run started",
        detail: `${workbook.name} · batch uploaded ${uploadedOn.trim()} · ${totalCount.trim()} records`,
        tone: "info",
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      setJob(await cancelJob(job.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const canStart =
    backendUp === true && !running && !starting && missing.length === 0 && !countInvalid;

  return (
    <div className="transform-wizard">
      {backendUp === false && (
        <div className="notice transform-error" role="alert">
          <span>
            <TriangleAlert size={14} /> The Python backend isn't running. Start it with{" "}
            <code>npm run dev:api</code> in a second terminal.
          </span>
          <Button variant="ghost" size="sm" onClick={() => void checkBackend()}>
            <RefreshCw />
            Check again
          </Button>
        </div>
      )}

      <Step
        number={1}
        title="Upload filled template"
        aside="The bulk import file already imported to the CLM"
      >
        <div className="transform-slots request-id-slots">
          <FileSlot
            title="Filled bulk import template"
            hint='Needs a "Contract Request" sheet with Record Reference Id'
            accept=".xlsx"
            files={workbook ? [workbook] : []}
            onAdd={(f) => setWorkbook(f[0] ?? null)}
            onRemove={() => setWorkbook(null)}
          />
        </div>
      </Step>

      <Step number={2} title="CLM connection and batch" aside="The password is never saved">
        <div className="request-id-fields">
          <label className="transform-field">
            <span>Site URL</span>
            <input
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              placeholder="https://cloud9.contractpod.com/<tenant>/help.aspx"
              spellCheck={false}
            />
          </label>
          <label className="transform-field">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
            />
          </label>
          <label className="transform-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="transform-field">
            <span>Uploaded On · exactly as shown on Bulk Import Upload</span>
            <input
              value={uploadedOn}
              onChange={(e) => setUploadedOn(e.target.value)}
              placeholder="2026-10-05 04:16 PM"
              spellCheck={false}
            />
          </label>
          <label className="transform-field">
            <span>Total count · records in the batch</span>
            <input
              value={totalCount}
              onChange={(e) => setTotalCount(e.target.value)}
              inputMode="numeric"
              className={countInvalid ? "transform-missing" : ""}
              placeholder="13"
            />
          </label>
          <label className="transform-field">
            <span>Template name · optional, narrows the batch match</span>
            <input value={template} onChange={(e) => setTemplate(e.target.value)} />
          </label>
        </div>
        <div className="request-id-options">
          <label className="request-id-check">
            <input
              type="checkbox"
              checked={supportingDocs}
              onChange={(e) => setSupportingDocs(e.target.checked)}
            />
            Fill the Supporting Document sheet
          </label>
          <label className="request-id-check">
            <input
              type="checkbox"
              checked={showBrowser}
              onChange={(e) => setShowBrowser(e.target.checked)}
            />
            Show the browser while running
          </label>
        </div>
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

      <Step
        number={3}
        title="Populate Request IDs"
        aside={
          running
            ? "Running: Completed records take about 10 seconds each"
            : job
              ? `Last run: ${job.workbookName}`
              : undefined
        }
      >
        <div className="transform-actions transform-actions-start">
          <Button disabled={!canStart} onClick={() => void start()}>
            {starting || running ? <LoaderCircle className="animate-spin" /> : <Play />}
            {running ? "Running…" : job ? "Run again" : "Start"}
          </Button>
          {running && (
            <Button variant="outline" onClick={() => void cancel()}>
              <Square />
              Cancel
            </Button>
          )}
          {!running && missing.length > 0 && (
            <span className="transform-warning">
              <TriangleAlert size={13} /> Still needed: {missing.join(", ")}.
            </span>
          )}
          {countInvalid && (
            <span className="transform-warning">
              <TriangleAlert size={13} /> Total count must be a whole number.
            </span>
          )}
        </div>

        {job && (
          <>
            <div className="transform-summary transform-summary-spaced">
              <Metric
                label="Records in batch"
                value={job.counters.total}
                note="From the Bulk Import Report"
              />
              <Metric
                label="Filled"
                value={job.counters.processed}
                tone={job.counters.processed ? "success" : "neutral"}
                note="Request ID, Record ID, file names"
              />
              <Metric
                label="Not ready yet"
                value={job.counters.notReady}
                tone={job.counters.notReady ? "warning" : "neutral"}
                note="New or In Progress on the CLM"
              />
              <Metric
                label="No match"
                value={job.counters.noMatch}
                tone={job.counters.noMatch ? "warning" : "neutral"}
                note="Record Reference Id not in the batch"
              />
              <Metric
                label="Errors"
                value={job.counters.errors}
                tone={job.counters.errors ? "danger" : "neutral"}
                note="Retried on the next run"
              />
            </div>
            {logs.length > 0 && (
              <div className="request-id-log" ref={logBox} aria-label="Run log">
                {logs.map((l, i) => (
                  <div key={`${l.time}-${i}`} className={`level-${l.level.toLowerCase()}`}>
                    <span>{new Date(l.time * 1000).toLocaleTimeString()}</span> {l.message}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Step>

      {job && job.status !== "running" && (
        <Step number={4} title="Results" aside={resultLabel(job)}>
          <RunResults job={job} records={records} onDownload={(what) => log(what)} />
        </Step>
      )}
    </div>
  );
}

function resultLabel(job: JobView): string {
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "failed") return "Failed";
  return job.result?.fully_completed ? "Every row filled" : "Partially filled";
}

function RunResults({
  job,
  records,
  onDownload,
}: {
  job: JobView;
  records: JobRecord[];
  onDownload: (event: { title: string; detail: string; tone: "success" }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = expanded
    ? records.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
    : records.slice(0, PREVIEW_ROWS);
  const errors = job.result?.errors ?? [];

  return (
    <>
      {errors.map((e) => (
        <p key={e} className="transform-warning">
          <TriangleAlert size={13} /> {e}
        </p>
      ))}
      {job.status === "done" && !job.result?.fully_completed && (
        <p className="transform-warning">
          <TriangleAlert size={13} /> Some rows aren't filled yet (records still processing on the
          CLM, or not matched). Download the workbook and run it again later; filled rows are kept
          and only the gaps are filled.
        </p>
      )}

      <div className="transform-actions transform-actions-start">
        {job.hasWorkbook && (
          <Button asChild>
            <a
              href={workbookUrl(job.id)}
              download={job.workbookName}
              onClick={() =>
                onDownload({
                  title: "Request ID workbook downloaded",
                  detail: job.workbookName,
                  tone: "success",
                })
              }
            >
              <ArrowDownToLine />
              Download updated workbook
            </a>
          </Button>
        )}
        {job.hasReport && (
          <Button variant="outline" asChild>
            <a href={reportUrl(job.id)} download>
              <ArrowDownToLine />
              Download report (.csv)
            </a>
          </Button>
        )}
      </div>

      {records.length > 0 && (
        <div className="table-section">
          <div className="table-overflow">
            <table className="document-table transform-table">
              <thead>
                <tr>
                  <th>Record Reference Id</th>
                  <th>Request ID</th>
                  <th>Record ID</th>
                  <th>Status</th>
                  <th>File names</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.record_reference_id}-${i}`}>
                    <td className="request-id">{r.record_reference_id}</td>
                    <td>
                      {r.detail_url ? (
                        <a href={r.detail_url} target="_blank" rel="noreferrer" className="browse">
                          {r.request_id}
                        </a>
                      ) : (
                        r.request_id || "—"
                      )}
                    </td>
                    <td>{r.record_id || "—"}</td>
                    <td>
                      <span className={`badge tone-${statusTone(r.status)}`}>
                        <i />
                        {r.status || "—"}
                      </span>
                    </td>
                    <td className="transform-sample transform-wrap">{r.file_names || "—"}</td>
                    <td className="transform-sample">{r.error_message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!expanded && records.length > PREVIEW_ROWS && (
            <div className="transform-actions transform-actions-start">
              <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                <ChevronDown />
                Show more ({records.length - PREVIEW_ROWS} more)
              </Button>
            </div>
          )}
          {expanded && (
            <div className="table-footer">
              <span>
                Showing {current * PAGE_SIZE + 1}–
                {Math.min((current + 1) * PAGE_SIZE, records.length)} of {records.length}
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
      {job.status !== "cancelled" && !records.length && (
        <p className="transform-note">No rows were written in this run.</p>
      )}
    </>
  );
}
