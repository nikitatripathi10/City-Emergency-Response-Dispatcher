import type { OfflineQueuedReport } from "../types/models";

const QUEUE_STORAGE_KEY = "cers_offline_report_queue_v1";

export function getOfflineQueue(): OfflineQueuedReport[] {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineReport(
  report: Omit<OfflineQueuedReport, "localId" | "queuedAtMs">
): OfflineQueuedReport {
  const queue = getOfflineQueue();
  const entry: OfflineQueuedReport = {
    ...report,
    localId: `offline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    queuedAtMs: Date.now(),
  };
  queue.push(entry);
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore quota errors
  }
  return entry;
}

export function removeOfflineQueuedReport(localId: string): void {
  const filtered = getOfflineQueue().filter((item) => item.localId !== localId);
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // Ignore storage errors
  }
}
