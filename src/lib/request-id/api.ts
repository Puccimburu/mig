// Client for the Python backend's Populate Request ID routes (backend/app.py).
// In development Vite proxies /api to the backend (see vite.config.ts).

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export type JobLog = { level: string; logger: string; message: string; time: number };

export type JobCounters = {
  /** Records in the matched batch report. */
  total: number;
  /** Rows written to the workbook. */
  processed: number;
  /** Still New / In Progress on the CLM; filled by a later run. */
  notReady: number;
  /** No report record for the row's Record Reference Id, or an unknown status. */
  noMatch: number;
  errors: number;
};

export type JobResult = {
  success: boolean;
  processed?: number;
  skipped_not_ready?: number;
  skipped_no_match?: number;
  /** Every row of the workbook now has all its values. */
  fully_completed?: boolean;
  errors?: string[];
};

export type JobView = {
  id: string;
  status: JobStatus;
  workbookName: string;
  startedAt: number;
  finishedAt: number | null;
  counters: JobCounters;
  /** Log lines after the `since` offset that was asked for. */
  logs: JobLog[];
  logCount: number;
  result: JobResult | null;
  hasWorkbook: boolean;
  hasReport: boolean;
};

/** One row of the run's detailed report. */
export type JobRecord = {
  timestamp: string;
  record_reference_id: string;
  request_id: string;
  record_id: string;
  file_names: string;
  file_path: string;
  status: string;
  error_message: string;
  detail_url: string;
};

export type JobSettings = {
  url: string;
  username: string;
  password: string;
  uploaded_on: string;
  total_count: string;
  template: string;
  supporting_docs: boolean;
  headless: boolean;
};

const BASE = "/api/request-id/jobs";

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

export async function backendAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/health");
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

export function startJob(workbook: File, settings: JobSettings): Promise<JobView> {
  const fd = new FormData();
  fd.append("workbook", workbook);
  fd.append("options", JSON.stringify(settings));
  return fetch(BASE, { method: "POST", body: fd }).then((r) => json<JobView>(r));
}

export function getJob(id: string, since = 0): Promise<JobView> {
  return fetch(`${BASE}/${id}?since=${since}`).then((r) => json<JobView>(r));
}

export function cancelJob(id: string): Promise<JobView> {
  return fetch(`${BASE}/${id}/cancel`, { method: "POST" }).then((r) => json<JobView>(r));
}

export function getRecords(id: string): Promise<JobRecord[]> {
  return fetch(`${BASE}/${id}/records`).then((r) => json<JobRecord[]>(r));
}

export const workbookUrl = (id: string) => `${BASE}/${id}/workbook`;
export const reportUrl = (id: string) => `${BASE}/${id}/report`;
