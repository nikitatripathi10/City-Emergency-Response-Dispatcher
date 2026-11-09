import type { EmergencyType, IncidentRecord, ReportedSeverity } from "../types/models";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB

export function isValidImageSrc(src: unknown): src is string {
  if (typeof src !== "string" || !src) return false;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) {
    return true;
  }
  try {
    const parsed = new URL(src);
    return parsed.protocol === "https:" && parsed.hostname === "firebasestorage.googleapis.com";
  } catch {
    return false;
  }
}

export function validateImageFile(file: { type: string; size: number }): {
  valid: boolean;
  error?: string;
} {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return { valid: false, error: "Unsupported image format. Allowed: JPEG, PNG, WebP." };
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_SIZE_BYTES) {
    return { valid: false, error: "Image size must be between 1 byte and 5 MB." };
  }
  return { valid: true };
}

export function validateIncidentInput(input: {
  type: string;
  reportedSeverity: string;
  location: string;
  desc: string;
  peopleAffected: number;
}): { valid: boolean; error?: string } {
  const validTypes: EmergencyType[] = ["Fire", "Medical", "Accident", "Police", "Minor"];
  const validSeverities: ReportedSeverity[] = ["critical", "high", "moderate", "low"];

  if (!validTypes.includes(input.type as EmergencyType)) {
    return { valid: false, error: "Invalid emergency category." };
  }
  if (!validSeverities.includes(input.reportedSeverity as ReportedSeverity)) {
    return { valid: false, error: "Invalid severity level." };
  }
  const loc = (input.location || "").trim();
  if (loc.length < 3 || loc.length > 300) {
    return { valid: false, error: "Location must be between 3 and 300 characters." };
  }
  const desc = (input.desc || "").trim();
  if (desc.length < 5 || desc.length > 2000) {
    return { valid: false, error: "Description must be between 5 and 2000 characters." };
  }
  if (!Number.isFinite(input.peopleAffected) || input.peopleAffected < 1 || input.peopleAffected > 10000) {
    return { valid: false, error: "People affected must be between 1 and 10,000." };
  }
  return { valid: true };
}

function escapeCsvCell(value: unknown): string {
  const raw = String(value ?? "");
  // Guard against spreadsheet formula injection (=, +, -, @)
  const sanitized = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

export function exportIncidentsToCsv(incidents: IncidentRecord[]): string {
  const headers = [
    "ID",
    "Type",
    "Severity",
    "Priority",
    "PriorityScore",
    "Status",
    "Location",
    "Latitude",
    "Longitude",
    "DistanceKm",
    "PeopleAffected",
    "AssignedUnits",
    "Rating",
    "CreatedAtISO",
    "ResolvedAtISO",
  ];
  const rows = incidents.map((e) => [
    e.id,
    e.type,
    e.reportedSeverity,
    e.priority,
    e.priorityScore,
    e.status,
    e.location,
    e.coordinates?.lat ?? "",
    e.coordinates?.lng ?? "",
    e.distance,
    e.peopleAffected,
    (e.assignedUnitIds || []).join(";"),
    e.rating ?? "",
    e.createdAtMs ? new Date(e.createdAtMs).toISOString() : "",
    e.resolvedAtMs ? new Date(e.resolvedAtMs).toISOString() : "",
  ]);

  return [headers.join(","), ...rows.map((r) => r.map(escapeCsvCell).join(","))].join("\n");
}
