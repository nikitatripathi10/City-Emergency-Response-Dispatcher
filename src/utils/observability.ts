export interface LogEvent {
  level: "info" | "warn" | "error";
  event: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

const recentLogs: LogEvent[] = [];

export function initObservability(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("error", (ev) => {
    captureException(ev.error || new Error(ev.message), { source: "window.onerror" });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    captureException(ev.reason, { source: "unhandledrejection" });
  });
}

export function logStructuredEvent(
  level: "info" | "warn" | "error",
  event: string,
  context?: Record<string, unknown>
): void {
  const entry: LogEvent = {
    level,
    event,
    context,
    timestamp: new Date().toISOString(),
  };
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();

  if (level === "error") {
    console.error(`[CERS:${event}]`, entry);
  } else if (level === "warn") {
    console.warn(`[CERS:${event}]`, entry);
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  const message = err instanceof Error ? err.message : String(err);
  logStructuredEvent("error", "exception_captured", { message, ...context });

  const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};
  const sentryDsn = env.VITE_SENTRY_DSN;
  if (sentryDsn && typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(
        sentryDsn,
        JSON.stringify({ message, context, timestamp: new Date().toISOString() })
      );
    } catch {
      // Ignore telemetry transport errors
    }
  }
}

export function getRecentDiagnostics(): LogEvent[] {
  return [...recentLogs];
}
