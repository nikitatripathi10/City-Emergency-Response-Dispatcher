import type {
  EmergencyType,
  IncidentRecord,
  IncidentStatus,
  PriorityLevel,
  ReportedSeverity,
  ResponseUnit,
  UnitType,
  UserRole,
  VulnerabilityFlag,
} from "../types/models";
import { computeHaversineKm, estimateEtaMinutes } from "./geo";

export interface PriorityInput {
  type: EmergencyType;
  reportedSeverity: ReportedSeverity;
  peopleAffected: number;
  vulnerabilityFlags: VulnerabilityFlag[];
  distanceKm: number;
  minutesWaiting?: number;
}

export interface PriorityResult {
  score: number;
  level: PriorityLevel;
  weight: number;
}

const BASE_TYPE_SCORES: Record<EmergencyType, number> = {
  Fire: 40,
  Medical: 38,
  Accident: 32,
  Police: 28,
  Minor: 12,
};

const BASE_TYPE_WEIGHTS: Record<EmergencyType, number> = {
  Fire: 1,
  Medical: 2,
  Accident: 3,
  Police: 4,
  Minor: 5,
};

const SEVERITY_SCORES: Record<ReportedSeverity, number> = {
  critical: 30,
  high: 22,
  moderate: 12,
  low: 4,
};

const VULNERABILITY_BONUS: Record<VulnerabilityFlag, number> = {
  trapped: 12,
  hazmat: 10,
  children: 6,
  elderly: 6,
};

export function calculatePriorityScore(input: PriorityInput): PriorityResult {
  const base = BASE_TYPE_SCORES[input.type] ?? 15;
  const sev = SEVERITY_SCORES[input.reportedSeverity] ?? 10;
  const peopleBonus = Math.min(15, Math.max(0, (input.peopleAffected - 1) * 3));

  let vulnBonus = 0;
  for (const flag of input.vulnerabilityFlags || []) {
    vulnBonus += VULNERABILITY_BONUS[flag] ?? 0;
  }
  vulnBonus = Math.min(20, vulnBonus);

  // Proximity factor (up to 5 points for close range, but primary drivers are type & severity)
  const distanceFactor = input.distanceKm < 5 ? 5 : input.distanceKm <= 10 ? 3 : 1;

  // SLA waiting time escalation (+2 points per 5 minutes waiting unassigned, up to +20)
  const waitBonus = Math.min(20, Math.floor(Math.max(0, input.minutesWaiting ?? 0) / 5) * 2);

  const rawScore = Math.min(100, base + sev + peopleBonus + vulnBonus + distanceFactor + waitBonus);

  let level: PriorityLevel;
  if (rawScore >= 75) level = "Critical";
  else if (rawScore >= 55) level = "High";
  else if (rawScore >= 35) level = "Medium";
  else level = "Low";

  let weight = BASE_TYPE_WEIGHTS[input.type] ?? 5;
  if (level === "Critical") weight = 1;
  else if (level === "High" && weight > 2) weight = weight - 1;

  return { score: rawScore, level, weight };
}

export const VALID_STATE_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  reported: ["verified", "assigned", "false_alarm", "cancelled"],
  Pending: ["verified", "assigned", "resolved", "Resolved", "false_alarm", "cancelled"],
  verified: ["assigned", "false_alarm", "cancelled"],
  assigned: ["en_route", "on_scene", "resolved", "cancelled"],
  en_route: ["on_scene", "resolved"],
  on_scene: ["resolved"],
  resolved: ["closed"],
  Resolved: ["closed"],
  closed: [],
  false_alarm: [],
  cancelled: [],
};

export function canTransitionState(
  from: IncidentStatus,
  to: IncidentStatus,
  role: UserRole,
  isReporter = false
): boolean {
  const allowedNext = VALID_STATE_TRANSITIONS[from] || [];
  if (!allowedNext.includes(to)) return false;

  if (role === "admin" || role === "dispatcher") {
    return true;
  }

  if (role === "responder") {
    return (
      (from === "assigned" && to === "en_route") ||
      (from === "en_route" && to === "on_scene") ||
      (from === "on_scene" && to === "resolved")
    );
  }

  if (role === "citizen" && isReporter) {
    return (from === "reported" || from === "Pending") && to === "cancelled";
  }

  return false;
}

export function isDuplicateIncident(
  candidate: { type: EmergencyType; coordinates: { lat: number; lng: number } | null; createdAtMs: number },
  existing: IncidentRecord,
  radiusKm = 0.35,
  windowMs = 30 * 60 * 1000
): boolean {
  if (existing.archived || existing.mergedIntoId) return false;
  if (["resolved", "Resolved", "closed", "false_alarm", "cancelled"].includes(existing.status)) {
    return false;
  }
  if (candidate.type !== existing.type) return false;
  if (!candidate.coordinates || !existing.coordinates) return false;

  const timeDiff = Math.abs(candidate.createdAtMs - existing.createdAtMs);
  if (timeDiff > windowMs) return false;

  const dist = computeHaversineKm(
    candidate.coordinates.lat,
    candidate.coordinates.lng,
    existing.coordinates.lat,
    existing.coordinates.lng
  );
  return dist <= radiusKm;
}

export function recommendUnitsForIncident(
  incident: Pick<IncidentRecord, "type" | "coordinates">,
  units: ResponseUnit[]
): Array<ResponseUnit & { distanceKm: number; etaMinutes: number; typeMatch: boolean }> {
  const preferredUnitType: Record<EmergencyType, UnitType> = {
    Fire: "Fire",
    Medical: "Medical",
    Accident: "Medical",
    Police: "Police",
    Minor: "Rescue",
  };
  const targetType = preferredUnitType[incident.type] || "Rescue";

  return units
    .filter((u) => u.status === "available")
    .map((u) => {
      const distanceKm = incident.coordinates
        ? computeHaversineKm(
            incident.coordinates.lat,
            incident.coordinates.lng,
            u.coordinates.lat,
            u.coordinates.lng
          )
        : 5.0;
      const etaMinutes = estimateEtaMinutes(distanceKm, u.type);
      const typeMatch = u.type === targetType || (incident.type === "Accident" && u.type === "Police");
      return { ...u, distanceKm, etaMinutes, typeMatch };
    })
    .sort((a, b) => {
      if (a.typeMatch !== b.typeMatch) return a.typeMatch ? -1 : 1;
      return a.etaMinutes - b.etaMinutes;
    });
}
