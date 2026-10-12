import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  LoaderCircle,
  RefreshCw,
  Search,
  Square,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";

import { useActivity } from "@/components/activity";
import { downloadBlob, FileSlot, Metric, Step } from "@/components/transformation/parts";
import { Button } from "@/components/ui/button";
import {
  applyNames,
  cancelUsersJob,
  checkNames,
  getUsersJob,
  getUsersList,
  inspectWorkbook,
  startUsersJob,
  uploadUsersList,
  usersListFileUrl,
  type CheckResult,
  type CheckRow,
  type CheckStatus,
  type Decision,
  type RowStatus,
  type SheetSummary,
  type UsersJob,
  type UsersListMeta,
} from "@/lib/name-check/api";
import { backendAvailable, type JobLog } from "@/lib/request-id/api";

// Shared with Populate Request ID: the same CLM site.
const URL_KEY = "auto-migrate.clm-url";
const JOB_KEY = "auto-migrate.users-job";
const POLL_MS = 2000;
const MAX_LOG_LINES = 300;
const PREVIEW_ROWS = 10;
const PAGE_SIZE = 25;
const NOT_FOUND_VALUE = "\u0000not-found";

const STATUS_TONE: Record<RowStatus, string> = {
  Matched: "success",
  Review: "warning",
  "Not Found": "danger",
  "Already filled": "neutral",
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

const rowKey = (r: { row: number; column: string }) => `${r.column}\u0000${r.row}`;

type Choice = { name: string | null; status: CheckStatus };

export function NameCheckWizard() {
  const { log } = useActivity();
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [usersList, setUsersList] = useState<UsersListMeta | null>(null);
  const [error, setError] = useState("");

  // Step 2-3: workbook, columns, results.
  const [workbook, setWorkbook] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetSummary[] | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState<"inspect" | "check" | "download" | null>(null);

  const sheet = sheets?.find((s) => s.name === sheetName);

  async function refreshUsersList() {
    try {
      setUsersList(await getUsersList());
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function checkBackend() {
    setBackendUp(null);
    const up = await backendAvailable();
    setBackendUp(up);
    if (up) await refreshUsersList();
  }

  useEffect(() => {
    void checkBackend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function chooseWorkbook(file: File | null) {
    setWorkbook(file);
    setSheets(null);
    setSheetName("");
    setColumns([]);
    setResult(null);
    setError("");
    if (!file) return;
    setBusy("inspect");
    try {
      const { sheets: found } = await inspectWorkbook(file);
      setSheets(found);
      chooseSheet(found.find((s) => s.suggested.length) ?? found[0]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function chooseSheet(s: SheetSummary | undefined) {
    setSheetName(s?.name ?? "");
    setColumns(s?.suggested ?? []);
    setResult(null);
  }

  function toggleColumn(name: string) {
    setResult(null);
    setColumns((c) =>
      c.includes(name)
        ? c.filter((x) => x !== name)
        : // Keep the sheet's column order.
          (sheet?.headers ?? []).filter((h) => h === name || c.includes(h)),
    );
  }

  async function runCheck() {
    if (!workbook || !sheet) return;
    setBusy("check");
    setError("");
    try {
      const r = await checkNames(workbook, sheet.name, columns);
      setResult(r);
      setChoices({});
      log({
        title: "User names checked",
        detail: `${workbook.name} (${sheet.name}) · ${r.stats.Matched} matched · ${r.stats.Review} to review · ${r.stats["Not Found"]} not found`,
        tone: r.stats.Review || r.stats["Not Found"] ? "warning" : "success",
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const choiceOf = (r: CheckRow): Choice =>
    choices[rowKey(r)] ?? { name: r.name, status: r.status as CheckStatus };

  async function download() {
    if (!workbook || !sheet || !result) return;
    setBusy("download");
    setError("");
    try {
      const decisions: Decision[] = result.rows
        .filter((r) => r.status !== "Already filled")
        .map((r) => ({ row: r.row, column: r.column, ...choiceOf(r) }));
      const blob = await applyNames(workbook, sheet.name, columns, decisions);
      const name = workbook.name.replace(/\.xlsx$/i, "");
      downloadBlob(blob, `${name}_names-checked.xlsx`);
      const counts: Record<CheckStatus, number> = { Matched: 0, Review: 0, "Not Found": 0 };
      for (const d of decisions) counts[d.status]++;
      log({
        title: "Checked workbook downloaded",
        detail: `${workbook.name} · ${counts.Matched} matched · ${counts.Review} review · ${counts["Not Found"]} not found`,
        tone: "success",
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="transform-wizard">
      {backendUp === false && (
        <div className="notice transform-error" role="alert">
          <span>
            <TriangleAlert size={14} /> The Python backend isn't running. Restart{" "}
            <code>npm run dev</code>, or start it with <code>npm run dev:api</code>.
          </span>
          <Button variant="ghost" size="sm" onClick={() => void checkBackend()}>
            <RefreshCw />
            Check again
          </Button>
        </div>
      )}
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
        number={1}
        title="CLM users list"
        aside="Names are checked against the users on the CLM"
      >
        <UsersListStep
          backendUp={backendUp === true}
          usersList={usersList}
          onChanged={(meta) => {
            setUsersList(meta);
            setResult(null);
          }}
          onError={setError}
        />
      </Step>

      <Step number={2} title="Client workbook and name columns">
        <div className="transform-slots request-id-slots">
          <FileSlot
            title="Client data workbook"
            hint="Any sheet with user names, e.g. Business Owner or Assignee"
            accept=".xlsx"
            files={workbook ? [workbook] : []}
            onAdd={(f) => void chooseWorkbook(f[0] ?? null)}
            onRemove={() => void chooseWorkbook(null)}
          />
        </div>
        {busy === "inspect" && (
          <p className="transform-note">
            <LoaderCircle size={12} className="inline animate-spin" /> Reading the workbook…
          </p>
        )}
        {sheets && (
          <div className="transform-picker">
            <label className="transform-field">
              <span>
                <strong>Sheet</strong> · header in row 1
              </span>
              <select
                value={sheetName}
                onChange={(e) => chooseSheet(sheets.find((s) => s.name === e.target.value))}
              >
                {sheets.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name} ({s.rows} rows)
                  </option>
                ))}
              </select>
            </label>
            {sheet && (
              <fieldset className="name-check-columns">
                <legend>Name columns to check</legend>
                {sheet.headers.map((h) => (
                  <label key={h} className="request-id-check">
                    <input
                      type="checkbox"
                      checked={columns.includes(h)}
                      onChange={() => toggleColumn(h)}
                    />
                    <span>
                      {h}
                      {sheet.samples[h] && (
                        <span className="transform-note-inline"> · e.g. {sheet.samples[h]}</span>
                      )}
                    </span>
                  </label>
                ))}
                {!sheet.headers.length && (
                  <p className="transform-note">This sheet has no headers in row 1.</p>
                )}
              </fieldset>
            )}
          </div>
        )}
      </Step>

      {sheet && (
        <Step
          number={3}
          title="Check names"
          aside={
            result
              ? `${result.rows.length} names in ${columns.length} column${columns.length === 1 ? "" : "s"}`
              : undefined
          }
        >
          <div className="transform-actions transform-actions-start">
            <Button
              disabled={!usersList || !columns.length || busy !== null || backendUp !== true}
              onClick={() => void runCheck()}
            >
              {busy === "check" ? <LoaderCircle className="animate-spin" /> : <Search />}
              {result ? "Check again" : "Check names"}
            </Button>
            {!usersList && (
              <span className="transform-warning">
                <TriangleAlert size={13} /> Collect or upload the CLM users list in step 1.
              </span>
            )}
            {usersList && !columns.length && (
              <span className="transform-warning">
                <TriangleAlert size={13} /> Choose at least one name column.
              </span>
            )}
          </div>
          {result && (
            <CheckResults
              result={result}
              choiceOf={choiceOf}
              onChoose={(r, c) => setChoices((all) => ({ ...all, [rowKey(r)]: c }))}
              onAcceptAll={() =>
                setChoices((all) => {
                  const next = { ...all };
                  for (const r of result.rows)
                    if (r.status === "Review" && !all[rowKey(r)] && r.name)
                      next[rowKey(r)] = { name: r.name, status: "Matched" };
                  return next;
                })
              }
              onDownload={() => void download()}
              downloading={busy === "download"}
            />
          )}
        </Step>
      )}
    </div>
  );
}

function formatWhen(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UsersListStep({
  backendUp,
  usersList,
  onChanged,
  onError,
}: {
  backendUp: boolean;
  usersList: UsersListMeta | null;
  onChanged: (meta: UsersListMeta | null) => void;
  onError: (message: string) => void;
}) {
  const { log } = useActivity();
  const [mode, setMode] = useState<"collect" | "upload" | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showBrowser, setShowBrowser] = useState(true);
  const [job, setJob] = useState<UsersJob | null>(null);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const logCount = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  const running = job?.status === "running";

  // Remembered site URL, and a collection still running from before a reload.
  useEffect(() => {
    setSiteUrl(stored(URL_KEY));
  }, []);
  useEffect(() => {
    if (!backendUp) return;
    const id = stored(JOB_KEY);
    if (!id) return;
    getUsersJob(id)
      .then((view) => {
        logCount.current = view.logCount;
        setLogs(view.logs.slice(-MAX_LOG_LINES));
        setJob(view);
        if (view.status === "running") setMode("collect");
      })
      .catch(() => store(JOB_KEY, null));
  }, [backendUp]);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const id = job.id;
    const timer = window.setInterval(async () => {
      try {
        const view = await getUsersJob(id, logCount.current);
        logCount.current = view.logCount;
        if (view.logs.length) setLogs((l) => [...l, ...view.logs].slice(-MAX_LOG_LINES));
        setJob(view);
        if (view.status !== "running") void finished(view);
      } catch (e) {
        onError(errorMessage(e));
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs]);

  async function finished(view: UsersJob) {
    const c = view.counters;
    if (view.status === "done") {
      log({
        title: "CLM users list collected",
        detail: `${c.collected} users from ${c.pagesDone} pages`,
        tone: "success",
      });
      onChanged(await getUsersList());
      setMode(null);
    } else if (view.status === "cancelled") {
      log({
        title: "Users list collection cancelled",
        detail: `${c.collected} users read`,
        tone: "warning",
      });
    } else {
      log({
        title: "Users list collection failed",
        detail: view.result?.errors?.join("; ") || `${c.collected} of ${c.total} users read`,
        tone: "danger",
      });
    }
  }

  async function start() {
    setStarting(true);
    onError("");
    setLogs([]);
    logCount.current = 0;
    store(URL_KEY, siteUrl.trim());
    try {
      const view = await startUsersJob({
        url: siteUrl.trim(),
        username: username.trim(),
        password,
        headless: !showBrowser,
      });
      store(JOB_KEY, view.id);
      setJob(view);
      log({ title: "Users list collection started", detail: siteUrl.trim(), tone: "info" });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    onError("");
    try {
      const meta = await uploadUsersList(file);
      onChanged(meta);
      setMode(null);
      log({
        title: "CLM users list uploaded",
        detail: `${file.name} · ${meta.count} users`,
        tone: "success",
      });
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  const missing = [
    !siteUrl.trim() && "site URL",
    !username.trim() && "username",
    !password && "password",
  ].filter(Boolean) as string[];

  return (
    <>
      {usersList ? (
        <div className="name-check-list">
          <div>
            <strong>{usersList.count.toLocaleString()} users</strong>
            <span className="transform-note-inline">
              {" "}
              · {usersList.active.toLocaleString()} active ·{" "}
              {usersList.source === "collected"
                ? `collected from ${usersList.site ?? "the CLM"}`
                : "uploaded"}{" "}
              {formatWhen(usersList.savedAt)}
            </span>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <a href={usersListFileUrl} download="users.xlsx">
              <ArrowDownToLine />
              users.xlsx
            </a>
          </Button>
        </div>
      ) : (
        backendUp && (
          <p className="transform-warning">
            <TriangleAlert size={13} /> No users list yet. Collect it from the CLM, or upload a
            users.xlsx from an earlier collection.
          </p>
        )
      )}

      <div className="transform-actions transform-actions-start">
        <Button
          variant={mode === "collect" ? "default" : "outline"}
          disabled={!backendUp || (running && mode === "collect")}
          onClick={() => setMode(mode === "collect" ? null : "collect")}
        >
          <CloudDownload />
          {usersList ? "Collect again from the CLM" : "Collect from the CLM"}
        </Button>
        <Button
          variant={mode === "upload" ? "default" : "outline"}
          disabled={!backendUp || running}
          onClick={() => setMode(mode === "upload" ? null : "upload")}
        >
          <Upload />
          Upload users.xlsx
        </Button>
      </div>

      {mode === "upload" && (
        <div className="transform-slots request-id-slots transform-summary-spaced">
          <FileSlot
            title="CLM users list"
            hint='From the Users Collector: a sheet with "Name", "Email" and "Is Active?"'
            accept=".xlsx"
            files={[]}
            onAdd={(f) => void upload(f[0])}
            onRemove={() => undefined}
          />
          {uploading && (
            <p className="transform-note">
              <LoaderCircle size={12} className="inline animate-spin" /> Reading the users list…
            </p>
          )}
        </div>
      )}

      {mode === "collect" && (
        <>
          <div className="request-id-fields">
            <label className="transform-field">
              <span>Site URL</span>
              <input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="https://cloud9.contractpod.com/<tenant>/help.aspx"
                spellCheck={false}
                disabled={running}
              />
            </label>
            <label className="transform-field">
              <span>Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                disabled={running}
              />
            </label>
            <label className="transform-field">
              <span>Password · never saved</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={running}
              />
            </label>
          </div>
          <div className="request-id-options">
            <label className="request-id-check">
              <input
                type="checkbox"
                checked={showBrowser}
                onChange={(e) => setShowBrowser(e.target.checked)}
                disabled={running}
              />
              Show the browser while running
            </label>
          </div>
          <div className="transform-actions transform-actions-start">
            <Button
              disabled={!backendUp || running || starting || missing.length > 0}
              onClick={() => void start()}
            >
              {starting || running ? <LoaderCircle className="animate-spin" /> : <CloudDownload />}
              {running ? "Collecting…" : "Start collecting"}
            </Button>
            {running && job && (
              <Button
                variant="outline"
                onClick={() =>
                  void cancelUsersJob(job.id).then(setJob, (e) => onError(errorMessage(e)))
                }
              >
                <Square />
                Cancel
              </Button>
            )}
            {!running && missing.length > 0 && (
              <span className="transform-warning">
                <TriangleAlert size={13} /> Still needed: {missing.join(", ")}.
              </span>
            )}
          </div>
        </>
      )}

      {job && (mode === "collect" || running) && (
        <>
          <div className="transform-summary transform-summary-spaced">
            <Metric
              label="Users on the CLM"
              value={job.counters.total}
              note="From the table footer"
            />
            <Metric
              label="Collected"
              value={job.counters.collected}
              tone={job.status === "done" ? "success" : "neutral"}
              note={`Page ${job.counters.pagesDone} of ${job.counters.pages || "?"}`}
            />
            <Metric
              label="Errors"
              value={job.counters.errors}
              tone={job.counters.errors ? "danger" : "neutral"}
              note={
                job.status === "failed"
                  ? "The list was not saved"
                  : job.status === "cancelled"
                    ? "Cancelled"
                    : "Every page is checked"
              }
            />
          </div>
          {job.status === "failed" &&
            job.result?.errors?.map((e) => (
              <p key={e} className="transform-warning">
                <TriangleAlert size={13} /> {e}
              </p>
            ))}
          {logs.length > 0 && (
            <div className="request-id-log" ref={logBox} aria-label="Collection log">
              {logs.map((l, i) => (
                <div key={`${l.time}-${i}`} className={`level-${l.level.toLowerCase()}`}>
                  <span>{new Date(l.time * 1000).toLocaleTimeString()}</span> {l.message}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

const FILTERS: (RowStatus | "all")[] = ["all", "Review", "Not Found", "Matched", "Already filled"];

function CheckResults({
  result,
  choiceOf,
  onChoose,
  onAcceptAll,
  onDownload,
  downloading,
}: {
  result: CheckResult;
  choiceOf: (r: CheckRow) => Choice;
  onChoose: (r: CheckRow, c: Choice) => void;
  onAcceptAll: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  const [filter, setFilter] = useState<RowStatus | "all">(result.stats.Review ? "Review" : "all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);

  // Counts after the user's edits.
  const now: Record<RowStatus, number> = {
    Matched: 0,
    Review: 0,
    "Not Found": 0,
    "Already filled": 0,
  };
  for (const r of result.rows)
    now[r.status === "Already filled" ? "Already filled" : choiceOf(r).status]++;

  const visible = result.rows.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      `${r.value} ${r.name ?? ""} ${r.column}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = expanded
    ? visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
    : visible.slice(0, PREVIEW_ROWS);
  const where = result.outputs
    .map((o) => `“${o.correct}” and “${o.status}”${o.flag ? ` (and “${o.flag}”)` : ""}`)
    .join("; ");
  const pendingReview = result.rows.filter(
    (r) => r.status === "Review" && choiceOf(r).status === "Review",
  ).length;

  return (
    <>
      <div className="transform-summary transform-summary-spaced">
        <Metric
          label="Matched"
          value={now.Matched}
          tone="success"
          note="Filled with the CLM user name"
        />
        <Metric
          label="To review"
          value={now.Review}
          tone={now.Review ? "warning" : "success"}
          note="Close match, inactive, shared or ambiguous"
        />
        <Metric
          label="Not found"
          value={now["Not Found"]}
          tone={now["Not Found"] ? "danger" : "success"}
          note="Left blank"
        />
        <Metric label="Already filled" value={now["Already filled"]} note="Not changed" />
      </div>
      <small className="transform-note">
        Results go into {where}, next to each checked column. Rows that already have a correct name
        are left as they are.
      </small>

      <div className="transform-actions transform-actions-start">
        <Button disabled={downloading} onClick={onDownload}>
          {downloading ? <LoaderCircle className="animate-spin" /> : <ArrowDownToLine />}
          Download checked workbook
        </Button>
        {pendingReview > 0 && (
          <Button variant="outline" onClick={onAcceptAll}>
            <Check />
            Accept all {pendingReview} suggestions to review
          </Button>
        )}
      </div>

      <div className="table-section">
        <div className="table-tools">
          <div className="tabs" role="tablist" aria-label="Result">
            {FILTERS.filter((f) => f === "all" || result.stats[f]).map((f) => (
              <Button
                key={f}
                variant="ghost"
                role="tab"
                aria-selected={f === filter}
                className={`tab ${f === filter ? "active" : ""}`}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                }}
              >
                {f === "all" ? `All (${result.rows.length})` : `${f} (${result.stats[f]})`}
              </Button>
            ))}
          </div>
          <div className="filters">
            <div className="search-box">
              <Search />
              <input
                placeholder="Search names..."
                aria-label="Search names"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </div>
          </div>
        </div>
        <div className="table-overflow">
          <table className="document-table transform-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Column</th>
                <th>Name in the sheet</th>
                <th>CLM user</th>
                <th>Score</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ResultRow key={rowKey(r)} row={r} choice={choiceOf(r)} onChoose={onChoose} />
              ))}
              {!visible.length && (
                <tr>
                  <td colSpan={7} className="text-center text-muted-foreground h-24">
                    No names match.
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
    </>
  );
}

function ResultRow({
  row,
  choice,
  onChoose,
}: {
  row: CheckRow;
  choice: Choice;
  onChoose: (r: CheckRow, c: Choice) => void;
}) {
  const filled = row.status === "Already filled";
  const options = [
    ...new Set([...(row.name ? [row.name] : []), ...row.alternatives.map((a) => a.name)]),
  ];
  const changed = choice.status !== row.status || choice.name !== row.name;
  return (
    <tr>
      <td className="request-id">{row.row}</td>
      <td className="transform-sample">{row.column}</td>
      <td>{row.value}</td>
      <td>
        {filled ? (
          <span className="transform-sample">{row.name}</span>
        ) : (
          <div className="name-check-choice">
            <select
              aria-label={`CLM user for row ${row.row}, ${row.column}`}
              value={choice.status === "Not Found" || !choice.name ? NOT_FOUND_VALUE : choice.name}
              onChange={(e) =>
                onChoose(
                  row,
                  e.target.value === NOT_FOUND_VALUE
                    ? { name: null, status: "Not Found" }
                    : { name: e.target.value, status: "Matched" },
                )
              }
            >
              {options.map((name) => {
                const alt = row.alternatives.find((a) => a.name === name);
                return (
                  <option key={name} value={name}>
                    {name}
                    {alt ? ` · ${Math.round(alt.score * 100)}%` : ""}
                    {alt && !alt.active ? " · inactive" : ""}
                    {alt && alt.users > 1 ? ` · ${alt.users} users` : ""}
                  </option>
                );
              })}
              <option value={NOT_FOUND_VALUE}>— Not found (leave blank) —</option>
            </select>
            {choice.status === "Review" && row.name && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChoose(row, { name: row.name, status: "Matched" })}
              >
                <Check />
                Accept
              </Button>
            )}
          </div>
        )}
      </td>
      <td>{row.score === null ? "—" : `${Math.round(row.score * 100)}%`}</td>
      <td>
        <span className={`badge tone-${STATUS_TONE[filled ? row.status : choice.status]}`}>
          <i />
          {filled ? row.status : choice.status}
          {changed && !filled ? " · edited" : ""}
        </span>
      </td>
      <td className="transform-sample transform-wrap">
        {[...row.notes, ...(row.email ? [row.email] : [])].join(" · ")}
      </td>
    </tr>
  );
}
