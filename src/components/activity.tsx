import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type ActivityTone = "success" | "info" | "warning" | "danger";

/** Something that actually happened in the workspace. */
export type ActivityEvent = {
  id: string;
  /** Epoch milliseconds. */
  at: number;
  title: string;
  detail: string;
  tone: ActivityTone;
};

/** Document counts from the latest transformation run, shown on the dashboard cards. */
export type MigrationSnapshot = {
  at: number;
  clientFile: string;
  sheet: string;
  total: number;
  completed: number;
  needsAttention: number;
  pending: number;
  templatesFilled: number;
  templatesTotal: number;
};

const STORAGE_KEY = "auto-migrate.activity";
const SNAPSHOT_KEY = "auto-migrate.snapshot";
const MAX_EVENTS = 200;

type ActivityLog = {
  events: ActivityEvent[];
  log: (event: Omit<ActivityEvent, "id" | "at">) => void;
  clear: () => void;
  snapshot: MigrationSnapshot | null;
  recordSnapshot: (snapshot: MigrationSnapshot) => void;
};

const ActivityContext = createContext<ActivityLog | null>(null);

function readStored(): ActivityEvent[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ActivityEvent[]) : [];
  } catch {
    return [];
  }
}

function readSnapshot(): MigrationSnapshot | null {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    const parsed = raw ? (JSON.parse(raw) as MigrationSnapshot) : null;
    return parsed && typeof parsed.total === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, quota); the data still works for this visit.
  }
}

function store(events: ActivityEvent[]) {
  save(STORAGE_KEY, events);
}

/** Keeps the activity log for the whole app; entries persist in this browser. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [snapshot, setSnapshot] = useState<MigrationSnapshot | null>(null);

  // Load after mount so server and client render the same markup.
  useEffect(() => {
    const stored = readStored();
    if (stored.length) setEvents((current) => [...current, ...stored].slice(0, MAX_EVENTS));
    setSnapshot((current) => current ?? readSnapshot());
  }, []);

  const recordSnapshot = useCallback((next: MigrationSnapshot) => {
    setSnapshot(next);
    save(SNAPSHOT_KEY, next);
  }, []);

  const log = useCallback((event: Omit<ActivityEvent, "id" | "at">) => {
    const entry: ActivityEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    };
    setEvents((current) => {
      const next = [entry, ...current].slice(0, MAX_EVENTS);
      store(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    store([]);
  }, []);

  return (
    <ActivityContext.Provider value={{ events, log, clear, snapshot, recordSnapshot }}>
      {children}
    </ActivityContext.Provider>
  );
}

export function useActivity(): ActivityLog {
  const ctx = useContext(ActivityContext);
  if (!ctx) throw new Error("useActivity must be used inside <ActivityProvider>.");
  return ctx;
}

/** Re-render periodically so relative times ("2 min ago") stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "Just now", "5 min ago", "Today, 14:32", "Yesterday, 09:10" or "8 Oct 2026, 09:10". */
export function formatWhen(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${day}, ${time}`;
}
