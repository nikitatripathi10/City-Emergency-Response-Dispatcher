import { describe, it, expect } from "vitest";
import { computeHaversineKm, encodeGeohash, estimateEtaMinutes } from "../../src/utils/geo";
import {
  calculatePriorityScore,
  canTransitionState,
  isDuplicateIncident,
  recommendUnitsForIncident,
} from "../../src/utils/priority";
import {
  exportIncidentsToCsv,
  isValidImageSrc,
  validateImageFile,
  validateIncidentInput,
} from "../../src/utils/validators";
import type { IncidentRecord, ResponseUnit } from "../../src/types/models";

describe("Geospatial Utilities", () => {
  it("computes accurate Haversine distance between Connaught Place and India Gate", () => {
    const dist = computeHaversineKm(28.6315, 77.2167, 28.6129, 77.2295);
    expect(dist).toBeGreaterThan(2.0);
    expect(dist).toBeLessThan(2.6);
  });

  it("encodes deterministic 9-char geohashes", () => {
    const hash = encodeGeohash(28.6139, 77.209, 9);
    expect(hash).toHaveLength(9);
    expect(hash).toBe("ttnfv2u5c");
  });

  it("estimates realistic urban response ETAs", () => {
    expect(estimateEtaMinutes(4, "Police")).toBeLessThanOrEqual(7);
    expect(estimateEtaMinutes(10, "Fire")).toBeGreaterThanOrEqual(15);
  });
});

describe("Priority Scoring & SLA Escalation Engine", () => {
  it("scores critical Fire with trapped persons as Critical priority (weight 1)", () => {
    const res = calculatePriorityScore({
      type: "Fire",
      reportedSeverity: "critical",
      peopleAffected: 4,
      vulnerabilityFlags: ["trapped", "children"],
      distanceKm: 2.5,
      minutesWaiting: 0,
    });
    expect(res.level).toBe("Critical");
    expect(res.weight).toBe(1);
    expect(res.score).toBeGreaterThanOrEqual(85);
  });

  it("auto-escalates unassigned incidents waiting longer than SLA thresholds", () => {
    const initial = calculatePriorityScore({
      type: "Accident",
      reportedSeverity: "moderate",
      peopleAffected: 2,
      vulnerabilityFlags: [],
      distanceKm: 6,
      minutesWaiting: 0,
    });
    const escalated = calculatePriorityScore({
      type: "Accident",
      reportedSeverity: "moderate",
      peopleAffected: 2,
      vulnerabilityFlags: [],
      distanceKm: 6,
      minutesWaiting: 35,
    });
    expect(escalated.score).toBeGreaterThan(initial.score);
  });
});

describe("Incident Lifecycle State Machine & RBAC", () => {
  it("prevents citizens from resolving or verifying incidents", () => {
    expect(canTransitionState("reported", "verified", "citizen", true)).toBe(false);
    expect(canTransitionState("reported", "resolved", "citizen", true)).toBe(false);
    expect(canTransitionState("reported", "cancelled", "citizen", true)).toBe(true);
    expect(canTransitionState("reported", "cancelled", "citizen", false)).toBe(false);
  });

  it("enforces sequential responder transitions (assigned -> en_route -> on_scene -> resolved)", () => {
    expect(canTransitionState("assigned", "en_route", "responder")).toBe(true);
    expect(canTransitionState("en_route", "on_scene", "responder")).toBe(true);
    expect(canTransitionState("on_scene", "resolved", "responder")).toBe(true);
    expect(canTransitionState("reported", "resolved", "responder")).toBe(false);
  });

  it("allows dispatchers and admins to verify, assign, and close incidents", () => {
    expect(canTransitionState("reported", "verified", "dispatcher")).toBe(true);
    expect(canTransitionState("verified", "assigned", "dispatcher")).toBe(true);
    expect(canTransitionState("resolved", "closed", "admin")).toBe(true);
  });
});

describe("Duplicate Detection & Unit Recommendation", () => {
  const sampleIncident: IncidentRecord = {
    id: "inc_1",
    uid: "u1",
    reporterUid: "u1",
    type: "Fire",
    reportedSeverity: "high",
    peopleAffected: 2,
    vulnerabilityFlags: [],
    location: "Sector 18",
    desc: "Building smoke",
    coordinates: { lat: 28.6139, lng: 77.209 },
    geohash: "ttnfv2u5c",
    distance: 1.2,
    priorityScore: 70,
    priority: "High",
    weight: 1,
    status: "reported",
    assignedUnitIds: [],
    assignedResponderUids: [],
    mergedIntoId: null,
    duplicateCount: 0,
    img: "",
    media: [],
    rating: null,
    feedback: "",
    abuseFlags: 0,
    archived: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    resolvedAtMs: null,
  };

  it("detects duplicate incidents of the same type within 350m and 30 minutes", () => {
    const isDup = isDuplicateIncident(
      {
        type: "Fire",
        coordinates: { lat: 28.6142, lng: 77.2092 },
        createdAtMs: 1_700_000_300_000,
      },
      sampleIncident
    );
    expect(isDup).toBe(true);
  });

  it("recommends the nearest available matching unit first", () => {
    const units: ResponseUnit[] = [
      {
        id: "u_far",
        name: "Engine-Far",
        type: "Fire",
        status: "available",
        coordinates: { lat: 28.7, lng: 77.3 },
        geohash: "ttn",
        capacity: 4,
        contactPhone: "101",
        currentIncidentId: null,
        memberUids: [],
        updatedAtMs: Date.now(),
      },
      {
        id: "u_near",
        name: "Engine-Near",
        type: "Fire",
        status: "available",
        coordinates: { lat: 28.615, lng: 77.21 },
        geohash: "ttn",
        capacity: 4,
        contactPhone: "101",
        currentIncidentId: null,
        memberUids: [],
        updatedAtMs: Date.now(),
      },
    ];
    const recs = recommendUnitsForIncident(sampleIncident, units);
    expect(recs[0].id).toBe("u_near");
    expect(recs[0].typeMatch).toBe(true);
  });
});

describe("Security Validators & CSV Sanitization", () => {
  it("rejects XSS payloads in image URLs", () => {
    expect(isValidImageSrc("javascript:alert(1)")).toBe(false);
    expect(isValidImageSrc('data:image/jpeg;base64," onerror="alert(1)')).toBe(false);
    expect(isValidImageSrc("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
    expect(
      isValidImageSrc("https://firebasestorage.googleapis.com/v0/b/cers/o/img.jpg?alt=media")
    ).toBe(true);
  });

  it("validates image MIME type and 5MB size limit", () => {
    expect(validateImageFile({ type: "image/svg+xml", size: 1024 }).valid).toBe(false);
    expect(validateImageFile({ type: "image/jpeg", size: 6 * 1024 * 1024 }).valid).toBe(false);
    expect(validateImageFile({ type: "image/webp", size: 512 * 1024 }).valid).toBe(true);
  });

  it("neutralizes spreadsheet formula injection in CSV export", () => {
    const csv = exportIncidentsToCsv([
      {
        ...({
          id: "inc_csv",
          type: "Fire",
          reportedSeverity: "high",
          priority: "High",
          priorityScore: 70,
          status: "reported",
          location: "=CMD|' /C calc'!A0",
          coordinates: { lat: 28.6, lng: 77.2 },
          distance: 2.1,
          peopleAffected: 1,
          assignedUnitIds: [],
          rating: null,
          createdAtMs: 0,
          resolvedAtMs: null,
        } as unknown as IncidentRecord),
      },
    ]);
    expect(csv).toContain("'=CMD|' /C calc'!A0");
  });

  it("validates incident input constraints", () => {
    expect(
      validateIncidentInput({
        type: "Fire",
        reportedSeverity: "high",
        location: "Connaught Place",
        desc: "Smoke visible from 2nd floor",
        peopleAffected: 3,
      }).valid
    ).toBe(true);
  });
});
