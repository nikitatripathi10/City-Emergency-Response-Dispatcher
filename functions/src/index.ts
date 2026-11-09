import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
const messaging = admin.messaging();

const CONTROL_ROOM_LAT = Number(process.env.CONTROL_ROOM_LAT || 28.6139);
const CONTROL_ROOM_LNG = Number(process.env.CONTROL_ROOM_LNG || 77.209);

type UserRole = "citizen" | "responder" | "dispatcher" | "admin";
type IncidentStatus =
  | "reported"
  | "verified"
  | "assigned"
  | "en_route"
  | "on_scene"
  | "resolved"
  | "closed"
  | "false_alarm"
  | "cancelled"
  | "Pending"
  | "Resolved";

const VALID_TRANSITIONS: Record<string, string[]> = {
  reported: ["verified", "assigned", "false_alarm", "cancelled"],
  Pending: ["verified", "assigned", "resolved", "Resolved", "false_alarm", "cancelled"],
  verified: ["assigned", "false_alarm", "cancelled"],
  assigned: ["en_route", "on_scene", "resolved", "cancelled"],
  en_route: ["on_scene", "resolved"],
  on_scene: ["resolved"],
  resolved: ["closed"],
  Resolved: ["closed"],
};

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

function computePriority(data: FirebaseFirestore.DocumentData, minutesWaiting = 0) {
  const typeScores: Record<string, number> = {
    Fire: 40,
    Medical: 38,
    Accident: 32,
    Police: 28,
    Minor: 12,
  };
  const sevScores: Record<string, number> = {
    critical: 30,
    high: 22,
    moderate: 12,
    low: 4,
  };
  const vulnScores: Record<string, number> = {
    trapped: 12,
    hazmat: 10,
    children: 6,
    elderly: 6,
  };
  const baseWeights: Record<string, number> = {
    Fire: 1,
    Medical: 2,
    Accident: 3,
    Police: 4,
    Minor: 5,
  };

  const base = typeScores[data.type] ?? 15;
  const sev = sevScores[data.reportedSeverity] ?? 12;
  const peopleBonus = Math.min(15, Math.max(0, (Number(data.peopleAffected || 1) - 1) * 3));
  const flags: string[] = Array.isArray(data.vulnerabilityFlags) ? data.vulnerabilityFlags : [];
  const vulnBonus = Math.min(
    20,
    flags.reduce((acc, f) => acc + (vulnScores[f] ?? 0), 0)
  );
  const distKm = Number(data.distance ?? 5);
  const distFactor = distKm < 5 ? 5 : distKm <= 10 ? 3 : 1;
  const waitBonus = Math.min(20, Math.floor(Math.max(0, minutesWaiting) / 5) * 2);

  const score = Math.min(100, base + sev + peopleBonus + vulnBonus + distFactor + waitBonus);
  const level =
    score >= 75 ? "Critical" : score >= 55 ? "High" : score >= 35 ? "Medium" : "Low";
  let weight = baseWeights[data.type] ?? 5;
  if (level === "Critical") weight = 1;
  else if (level === "High" && weight > 2) weight -= 1;

  return { score, level, weight };
}

// ============================================================================
// 1. Firestore Trigger: Authoritative Triage, Distance & Push Alert on Create
// ============================================================================
export const onIncidentCreated = onDocumentCreated("emergencies/{incidentId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  const incidentId = event.params.incidentId;

  let distanceKm = Number(data.distance ?? 5);
  if (data.coordinates && typeof data.coordinates.latitude === "number") {
    distanceKm = haversineKm(
      CONTROL_ROOM_LAT,
      CONTROL_ROOM_LNG,
      data.coordinates.latitude,
      data.coordinates.longitude
    );
  }

  const triage = computePriority({ ...data, distance: distanceKm }, 0);

  await snap.ref.set(
    {
      distance: distanceKm,
      priorityScore: triage.score,
      priority: triage.level,
      weight: triage.weight,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  logger.info("Incident triaged", {
    incidentId,
    type: data.type,
    distanceKm,
    priorityScore: triage.score,
    priority: triage.level,
  });

  // Notify staff subscribed to 'dispatch-alerts' topic via FCM
  try {
    await messaging.send({
      topic: "dispatch-alerts",
      notification: {
        title: `🚨 [${triage.level}] ${data.type} Emergency`,
        body: `${data.location} (${distanceKm} km from control room)`,
      },
      data: {
        incidentId,
        type: String(data.type || ""),
        priority: triage.level,
      },
    });
  } catch (err) {
    logger.warn("FCM topic broadcast skipped", { error: String(err) });
  }
});

// ============================================================================
// 2. Callable: Validated State Machine Transition + Audit Log + Citizen Push
// ============================================================================
export const transitionIncidentState = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const callerUid = request.auth.uid;
  const callerRole = (request.auth.token.role as UserRole) || "citizen";
  const { incidentId, toState, note } = request.data as {
    incidentId: string;
    toState: IncidentStatus;
    note?: string;
  };

  if (!incidentId || !toState) {
    throw new HttpsError("invalid-argument", "incidentId and toState are required.");
  }

  const incRef = db.collection("emergencies").doc(incidentId);
  const incSnap = await incRef.get();
  if (!incSnap.exists) {
    throw new HttpsError("not-found", "Incident not found.");
  }

  const inc = incSnap.data()!;
  const fromState = String(inc.status || "reported");
  const allowedNext = VALID_TRANSITIONS[fromState] || [];

  if (!allowedNext.includes(toState)) {
    throw new HttpsError(
      "failed-precondition",
      `Illegal state transition: ${fromState} -> ${toState}`
    );
  }

  if (callerRole === "citizen") {
    if (inc.reporterUid !== callerUid || toState !== "cancelled") {
      throw new HttpsError("permission-denied", "Citizens can only cancel their own unassigned reports.");
    }
  } else if (callerRole === "responder") {
    const responderAllowed =
      (fromState === "assigned" && toState === "en_route") ||
      (fromState === "en_route" && toState === "on_scene") ||
      (fromState === "on_scene" && toState === "resolved");
    if (!responderAllowed) {
      throw new HttpsError("permission-denied", "Responder transition not permitted.");
    }
  }

  const updateFields: Record<string, unknown> = {
    status: toState,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (toState === "resolved" || toState === "Resolved") {
    updateFields.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await incRef.update(updateFields);

  await incRef.collection("timeline").add({
    incidentId,
    actorUid: callerUid,
    actorRole: callerRole,
    action: "status_change",
    fromState,
    toState,
    note: note || `Transitioned ${fromState} -> ${toState}`,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection("auditLogs").add({
    incidentId,
    actorUid: callerUid,
    actorRole: callerRole,
    action: `status:${fromState}->${toState}`,
    details: note || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("Incident state transitioned", { incidentId, fromState, toState, callerUid });
  return { success: true, incidentId, fromState, toState };
});

// ============================================================================
// 3. Callable: Admin-Only Role Assignment (Sets Firebase Custom Claims)
// ============================================================================
export const setUserRole = onCall(async (request) => {
  if (!request.auth || request.auth.token.role !== "admin") {
    throw new HttpsError("permission-denied", "Only administrators can assign roles.");
  }

  const { targetUid, role } = request.data as { targetUid: string; role: UserRole };
  const validRoles: UserRole[] = ["citizen", "responder", "dispatcher", "admin"];
  if (!targetUid || !validRoles.includes(role)) {
    throw new HttpsError("invalid-argument", "Valid targetUid and role are required.");
  }

  await auth.setCustomUserClaims(targetUid, { role });
  await db.collection("users").doc(targetUid).set(
    {
      role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await db.collection("auditLogs").add({
    incidentId: "RBAC_ROLE_ASSIGNMENT",
    actorUid: request.auth.uid,
    actorRole: "admin",
    action: "setCustomUserClaims",
    details: `Assigned role "${role}" to UID ${targetUid}`,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("Assigned custom role claim", { targetUid, role, adminUid: request.auth.uid });
  return { success: true, targetUid, role };
});

// ============================================================================
// 4. HTTPS Proxy: Rate-Limited Geocoding Proxy (Photon / Mapbox / Google)
// ============================================================================
const ipWindowMap = new Map<string, number[]>();

export const geocodeProxy = onRequest({ cors: true }, async (req, res) => {
  const clientIp = String(req.headers["x-forwarded-for"] || req.ip || "unknown");
  const now = Date.now();
  const recent = (ipWindowMap.get(clientIp) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 30) {
    res.status(429).json({ error: "Rate limit exceeded. Try again shortly." });
    return;
  }
  recent.push(now);
  ipWindowMap.set(clientIp, recent);

  const q = String(req.query.q || "").trim();
  const lang = String(req.query.lang || "en").slice(0, 2);
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }

  const provider = process.env.GEOCODER_PROVIDER || "photon";

  try {
    if (provider === "mapbox" && process.env.MAPBOX_ACCESS_TOKEN) {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${process.env.MAPBOX_ACCESS_TOKEN}&limit=6&language=${lang}`;
      const mbRes = await fetch(url);
      const mbData = (await mbRes.json()) as {
        features?: Array<{ place_name: string; text: string; center: [number, number] }>;
      };
      const results = (mbData.features || []).map((f) => ({
        displayName: f.place_name,
        mainText: f.text,
        subText: f.place_name.replace(`${f.text}, `, ""),
        lat: f.center[1],
        lng: f.center[0],
        provider: "mapbox",
      }));
      res.json({ results });
      return;
    }

    // Default: Photon (Komoot OpenStreetMap autocomplete service)
    const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${lang === "hi" ? "en" : lang}`;
    const pRes = await fetch(photonUrl);
    const pData = (await pRes.json()) as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: Record<string, string>;
      }>;
    };

    const results = (pData.features || [])
      .map((f) => {
        const coords = f.geometry?.coordinates;
        if (!coords) return null;
        const p = f.properties || {};
        const mainText = p.name || p.street || p.city || q;
        const subText = [p.district, p.city, p.state, p.country]
          .filter((x) => x && x !== mainText)
          .slice(0, 3)
          .join(", ");
        return {
          displayName: subText ? `${mainText}, ${subText}` : mainText,
          mainText,
          subText,
          lat: coords[1],
          lng: coords[0],
          provider: "photon",
        };
      })
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    logger.error("Geocoding proxy error", { error: String(err) });
    res.status(502).json({ error: "Upstream geocoder error" });
  }
});

// ============================================================================
// 5. Scheduled Function: Auto-Escalate Unassigned Incidents Every 5 Minutes
// ============================================================================
export const escalateUnassignedIncidents = onSchedule("every 5 minutes", async () => {
  const snap = await db
    .collection("emergencies")
    .where("archived", "==", false)
    .where("status", "in", ["reported", "Pending", "verified"])
    .get();

  const now = Date.now();
  let escalatedCount = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : data.timestamp || now;
    const minsWaiting = Math.floor((now - createdMs) / 60000);
    if (minsWaiting < 10) continue;

    const updatedTriage = computePriority(data, minsWaiting);
    if (updatedTriage.score > Number(data.priorityScore || 0)) {
      await docSnap.ref.update({
        priorityScore: updatedTriage.score,
        priority: updatedTriage.level,
        weight: updatedTriage.weight,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await docSnap.ref.collection("timeline").add({
        incidentId: docSnap.id,
        actorUid: "SYSTEM_SLA_ESCALATOR",
        actorRole: "admin",
        action: "priority_escalated",
        note: `Auto-escalated after ${minsWaiting}m unassigned to ${updatedTriage.level} (score ${updatedTriage.score})`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      escalatedCount++;
    }
  }

  logger.info("Completed SLA auto-escalation scan", { escalatedCount });
});
