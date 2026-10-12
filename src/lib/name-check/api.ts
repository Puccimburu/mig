// Client for the Python backend's users list and name check routes (backend/app.py).

import type { JobLog, JobStatus } from "@/lib/request-id/api";

export type UsersListMeta = {
  source: "collected" | "uploaded";
  /** CLM site the list was collected from. */
  site: string | null;
  /** Unix seconds. */
  savedAt: number;
  count: number;
  active: number;
};

export type UsersJob = {
  id: string;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  counters: { total: number; collected: number; pages: number; pagesDone: number; errors: number };
  logs: JobLog[];
  logCount: number;
  result: {
    success: boolean;
    users_collected?: number;
    pages_processed?: number;
    total_users?: number | null;
    duplicates_skipped?: number;
    errors?: string[];
  } | null;
};

export type SheetSummary = {
  name: string;
  rows: number;
  headers: string[];
  samples: Record<string, string>;
  /** Headers that look like user-name columns. */
  suggested: string[];
};

export type CheckStatus = "Matched" | "Review" | "Not Found";
export type RowStatus = CheckStatus | "Already filled";

export type Suggestion = { name: string; score: number; users: number; active: boolean };

export type CheckRow = {
  row: number;
  column: string;
  value: string;
  status: RowStatus;
  /** Best CLM user name (or the name already in the sheet). */
  name: string | null;
  score: number | null;
  notes: string[];
  alternatives: Suggestion[];
  email: string | null;
};

export type CheckResult = {
  sheet: string;
  outputs: { column: string; correct: string; status: string; flag: string | null }[];
  stats: Record<RowStatus, number>;
  rows: CheckRow[];
};

export type Decision = { row: number; column: string; name: string | null; status: CheckStatus };

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Not JSON (e.g. the proxy's own error page when the backend is down).
  }
  throw new Error(detail);
}

function form(file: File, field: string, options?: unknown) {
  const fd = new FormData();
  fd.append(field, file);
  if (options !== undefined) fd.append("options", JSON.stringify(options));
  return fd;
}

export function getUsersList(): Promise<UsersListMeta | null> {
  return fetch("/api/users-list").then((r) => json<UsersListMeta | null>(r));
}

export function uploadUsersList(file: File): Promise<UsersListMeta> {
  return fetch("/api/users-list", { method: "POST", body: form(file, "file") }).then((r) =>
    json<UsersListMeta>(r),
  );
}

export const usersListFileUrl = "/api/users-list/file";

export function startUsersJob(settings: {
  url: string;
  username: string;
  password: string;
  headless: boolean;
}): Promise<UsersJob> {
  const fd = new FormData();
  fd.append("options", JSON.stringify(settings));
  return fetch("/api/users-list/jobs", { method: "POST", body: fd }).then((r) => json<UsersJob>(r));
}

export function getUsersJob(id: string, since = 0): Promise<UsersJob> {
  return fetch(`/api/users-list/jobs/${id}?since=${since}`).then((r) => json<UsersJob>(r));
}

export function cancelUsersJob(id: string): Promise<UsersJob> {
  return fetch(`/api/users-list/jobs/${id}/cancel`, { method: "POST" }).then((r) =>
    json<UsersJob>(r),
  );
}

export function inspectWorkbook(file: File): Promise<{ sheets: SheetSummary[] }> {
  return fetch("/api/name-check/inspect", { method: "POST", body: form(file, "workbook") }).then(
    (r) => json<{ sheets: SheetSummary[] }>(r),
  );
}

export function checkNames(file: File, sheet: string, columns: string[]): Promise<CheckResult> {
  return fetch("/api/name-check/match", {
    method: "POST",
    body: form(file, "workbook", { sheet, columns }),
  }).then((r) => json<CheckResult>(r));
}

/** The workbook with the chosen names and statuses written in. */
export async function applyNames(
  file: File,
  sheet: string,
  columns: string[],
  decisions: Decision[],
): Promise<Blob> {
  const res = await fetch("/api/name-check/apply", {
    method: "POST",
    body: form(file, "workbook", { sheet, columns, decisions }),
  });
  if (!res.ok) await json(res);
  return res.blob();
}
