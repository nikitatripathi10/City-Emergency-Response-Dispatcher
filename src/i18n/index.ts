import en from "./en.json";
import hi from "./hi.json";

export type SupportedLocale = "en" | "hi";
export type TranslationKey = keyof typeof en;

const dictionaries: Record<SupportedLocale, Record<TranslationKey, string>> = {
  en,
  hi,
};

const STORAGE_KEY = "cers_locale";

let currentLocale: SupportedLocale = loadPersistedLocale();

function loadPersistedLocale(): SupportedLocale {
  try {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "en" || saved === "hi") return saved;
    }
  } catch {
    // Ignore storage read restrictions
  }
  return "en";
}

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function setLocale(locale: SupportedLocale): void {
  currentLocale = locale;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, locale);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  } catch {
    // Ignore storage restrictions
  }
}

export function t(key: TranslationKey): string {
  return dictionaries[currentLocale]?.[key] ?? dictionaries.en[key] ?? key;
}

export function formatDateTime(ms: number): string {
  if (!ms) return "—";
  const localeTag = currentLocale === "hi" ? "hi-IN" : "en-IN";
  return new Intl.DateTimeFormat(localeTag, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

export function formatNumber(num: number, maximumFractionDigits = 1): string {
  const localeTag = currentLocale === "hi" ? "hi-IN" : "en-IN";
  return new Intl.NumberFormat(localeTag, { maximumFractionDigits }).format(num);
}

export function formatRelativeTime(tsMs: number): string {
  if (!tsMs) return currentLocale === "hi" ? "अभी" : "just now";
  const diffSec = Math.round((tsMs - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(currentLocale === "hi" ? "hi-IN" : "en-IN", {
    numeric: "auto",
  });
  if (absSec < 60) return currentLocale === "hi" ? "अभी" : "just now";
  if (absSec < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (absSec < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}
