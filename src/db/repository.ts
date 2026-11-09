import {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  limit,
  serverTimestamp,
  GeoPoint,
  type Unsubscribe,
  type DocumentData,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "./firebase";
import type {
  EmergencyType,
  IncidentMedia,
  IncidentRecord,
  IncidentStatus,
  LatLng,
  ReportedSeverity,
  ResponseUnit,
  TimelineEvent,
  UnitStatus,
  UnitType,
  UserProfile,
  UserRole,
  VulnerabilityFlag,
} from "../types/models";
import { computeHaversineKm, encodeGeohash, getControlRoomCoords } from "../utils/geo";
import { calculatePriorityScore, canTransitionState } from "../utils/priority";
import { validateImageFile } from "../utils/validators";

function parseTimestampMs(val: unknown, fallback?: number): number {
  if (val && typeof (val as { toMillis?: () => number }).toMillis === "function") {
    return (val as { toMillis: () => number }).toMillis();
  }
  if (typeof val === "number") return val;
  return fallback ?? 0;
}

export function mapFirestoreDocToIncident(id: string, data: DocumentData): IncidentRecord {
  let coords: LatLng | null = null;
  if (data.coordinates) {
    if (typeof data.coordinates.latitude === "number") {
      coords = { lat: data.coordinates.latitude, lng: data.coordinates.longitude };
    } else if (typeof data.coordinates.lat === "number") {
      coords = { lat: Number(data.coordinates.lat), lng: Number(data.coordinates.lng) };
    }
  } else if (typeof data.lat === "number" && typeof data.lng === "number") {
    coords = { lat: data.lat, lng: data.lng };
  }

  const createdAtMs = parseTimestampMs(data.createdAt, data.timestamp || Date.now());
  const updatedAtMs = parseTimestampMs(data.updatedAt, createdAtMs);
  const resolvedAtMs = data.resolvedAt ? parseTimestampMs(data.resolvedAt) : null;

  return {
    id,
    uid: String(data.uid || data.reporterUid || ""),
    reporterUid: String(data.reporterUid || data.uid || ""),
    reporterEmail: data.reporterEmail ? String(data.reporterEmail) : undefined,
    type: (data.type as EmergencyType) || "Minor",
    reportedSeverity: (data.reportedSeverity as ReportedSeverity) || "moderate",
    peopleAffected: Number(data.peopleAffected || 1),
    vulnerabilityFlags: Array.isArray(data.vulnerabilityFlags) ? data.vulnerabilityFlags : [],
    location: String(data.location || ""),
    desc: String(data.desc || ""),
    coordinates: coords,
    geohash: String(data.geohash || (coords ? encodeGeohash(coords.lat, coords.lng) : "")),
    distance: Number(data.distance ?? 0),
    priorityScore: Number(data.priorityScore ?? 50),
    priority: data.priority || "Medium",
    weight: Number(data.weight ?? 5),
    status: (data.status as IncidentStatus) || "reported",
    assignedUnitIds: Array.isArray(data.assignedUnitIds) ? data.assignedUnitIds : [],
    assignedResponderUids: Array.isArray(data.assignedResponderUids)
      ? data.assignedResponderUids
      : [],
    mergedIntoId: data.mergedIntoId ? String(data.mergedIntoId) : null,
    duplicateCount: Number(data.duplicateCount ?? 0),
    img: String(data.img || (Array.isArray(data.media) && data.media[0]?.url) || ""),
    media: Array.isArray(data.media) ? data.media : [],
    rating: typeof data.rating === "number" ? data.rating : null,
    feedback: String(data.feedback || ""),
    abuseFlags: Number(data.abuseFlags ?? 0),
    archived: Boolean(data.archived),
    createdAtMs,
    updatedAtMs,
    resolvedAtMs,
  };
}

export async function compressAndUploadMedia(
  uid: string,
  incidentId: string,
  file: File
): Promise<IncidentMedia> {
  const check = validateImageFile(file);
  if (!check.valid) {
    throw new Error(check.error);
  }

  const compressedBlob = await new Promise<Blob>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxW = 960;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Compression failed"))),
          "image/jpeg",
          0.78
        );
      };
      img.onerror = () => reject(new Error("Invalid image data"));
      img.src = String(e.target?.result || "");
    };
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });

  const safeName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}.jpg`;
  const storagePath = `incident-media/${uid}/${incidentId}/${safeName}`;
  const fileRef = ref(storage, storagePath);

  await uploadBytes(fileRef, compressedBlob, { contentType: "image/jpeg" });
  const url = await getDownloadURL(fileRef);

  return {
    url,
    storagePath,
    mimeType: "image/jpeg",
    sizeBytes: compressedBlob.size,
  };
}

export function subscribeIncidents(
  userUid: string,
  role: UserRole,
  maxItems: number,
  onUpdate: (incidents: IncidentRecord[]) => void,
  onError: (err: Error) => void
): Unsubscribe {
  const col = collection(db, "emergencies");
  const q =
    role === "citizen"
      ? query(col, where("reporterUid", "==", userUid), limit(maxItems))
      : query(col, limit(maxItems));

  return onSnapshot(
    q,
    (snapshot) => {
      const list: IncidentRecord[] = [];
      snapshot.forEach((docSnap) => {
        const record = mapFirestoreDocToIncident(docSnap.id, docSnap.data());
        if (record.archived && role !== "admin") return;
        if (record.mergedIntoId && role === "citizen") return;
        list.push(record);
      });

      list.sort((a, b) => {
        if (a.weight !== b.weight) return a.weight - b.weight;
        if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
        return a.createdAtMs - b.createdAtMs;
      });
      onUpdate(list);
    },
    (err) => onError(err)
  );
}

export async function createIncidentReport(input: {
  reporterUid: string;
  reporterEmail?: string;
  type: EmergencyType;
  reportedSeverity: ReportedSeverity;
  peopleAffected: number;
  vulnerabilityFlags: VulnerabilityFlag[];
  location: string;
  desc: string;
  coordinates: LatLng | null;
  manualDistanceKm?: number;
  file?: File | null;
}): Promise<string> {
  const controlRoom = getControlRoomCoords();
  const computedDistKm = input.coordinates
    ? computeHaversineKm(
        controlRoom.lat,
        controlRoom.lng,
        input.coordinates.lat,
        input.coordinates.lng
      )
    : Math.max(0, Number(input.manualDistanceKm ?? 5));

  const priorityResult = calculatePriorityScore({
    type: input.type,
    reportedSeverity: input.reportedSeverity,
    peopleAffected: input.peopleAffected,
    vulnerabilityFlags: input.vulnerabilityFlags,
    distanceKm: computedDistKm,
  });

  const geohash = input.coordinates
    ? encodeGeohash(input.coordinates.lat, input.coordinates.lng)
    : "";

  const newDocRef = doc(collection(db, "emergencies"));

  const mediaList: IncidentMedia[] = [];
  if (input.file) {
    const uploaded = await compressAndUploadMedia(input.reporterUid, newDocRef.id, input.file);
    mediaList.push(uploaded);
  }

  await setDoc(newDocRef, {
    uid: input.reporterUid,
    reporterUid: input.reporterUid,
    reporterEmail: input.reporterEmail || "",
    type: input.type,
    reportedSeverity: input.reportedSeverity,
    peopleAffected: input.peopleAffected,
    vulnerabilityFlags: input.vulnerabilityFlags,
    location: input.location,
    desc: input.desc,
    coordinates: input.coordinates
      ? new GeoPoint(input.coordinates.lat, input.coordinates.lng)
      : null,
    geohash,
    distance: computedDistKm,
    priorityScore: priorityResult.score,
    priority: priorityResult.level,
    weight: priorityResult.weight,
    status: "reported",
    assignedUnitIds: [],
    assignedResponderUids: [],
    mergedIntoId: null,
    duplicateCount: 0,
    img: mediaList[0]?.url || "",
    media: mediaList,
    rating: null,
    feedback: "",
    abuseFlags: 0,
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    timestamp: Date.now(),
  });

  await recordTimelineEvent(newDocRef.id, {
    actorUid: input.reporterUid,
    actorRole: "citizen",
    action: "created",
    toState: "reported",
    note: `Incident reported (${input.type}, ${priorityResult.level} priority, score ${priorityResult.score})`,
  });

  return newDocRef.id;
}

export async function recordTimelineEvent(
  incidentId: string,
  event: {
    actorUid: string;
    actorRole: UserRole;
    action: TimelineEvent["action"];
    fromState?: IncidentStatus;
    toState?: IncidentStatus;
    note: string;
  }
): Promise<void> {
  try {
    await addDoc(collection(db, "emergencies", incidentId, "timeline"), {
      incidentId,
      actorUid: event.actorUid,
      actorRole: event.actorRole,
      action: event.action,
      fromState: event.fromState || null,
      toState: event.toState || null,
      note: event.note,
      createdAt: serverTimestamp(),
    });
  } catch {
    // Non-fatal if offline
  }
}

export async function fetchIncidentTimeline(incidentId: string): Promise<TimelineEvent[]> {
  const snap = await getDocs(collection(db, "emergencies", incidentId, "timeline"));
  const items: TimelineEvent[] = [];
  snap.forEach((d) => {
    const data = d.data();
    items.push({
      id: d.id,
      incidentId,
      actorUid: String(data.actorUid || ""),
      actorRole: (data.actorRole as UserRole) || "citizen",
      action: data.action || "status_change",
      fromState: data.fromState || undefined,
      toState: data.toState || undefined,
      note: String(data.note || ""),
      createdAtMs: parseTimestampMs(data.createdAt, Date.now()),
    });
  });
  return items.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function transitionIncidentWorkflow(params: {
  incident: IncidentRecord;
  toState: IncidentStatus;
  actorUid: string;
  actorRole: UserRole;
  note?: string;
}): Promise<void> {
  const isReporter = params.incident.reporterUid === params.actorUid;
  if (!canTransitionState(params.incident.status, params.toState, params.actorRole, isReporter)) {
    throw new Error(
      `Invalid state transition from "${params.incident.status}" to "${params.toState}" for role "${params.actorRole}".`
    );
  }

  const updatePayload: Record<string, unknown> = {
    status: params.toState,
    updatedAt: serverTimestamp(),
  };
  if (params.toState === "resolved" || params.toState === "Resolved") {
    updatePayload.resolvedAt = serverTimestamp();
  }

  await updateDoc(doc(db, "emergencies", params.incident.id), updatePayload);

  // Release assigned units when resolved/closed/cancelled/false_alarm
  if (
    ["resolved", "Resolved", "closed", "cancelled", "false_alarm"].includes(params.toState) &&
    params.incident.assignedUnitIds.length > 0
  ) {
    for (const unitId of params.incident.assignedUnitIds) {
      try {
        await updateDoc(doc(db, "units", unitId), {
          status: "available",
          currentIncidentId: null,
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Ignore if unit already released
      }
    }
  }

  await recordTimelineEvent(params.incident.id, {
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    action: "status_change",
    fromState: params.incident.status,
    toState: params.toState,
    note: params.note || `Transitioned ${params.incident.status} → ${params.toState}`,
  });

  await addDoc(collection(db, "auditLogs"), {
    incidentId: params.incident.id,
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    action: `status:${params.incident.status}->${params.toState}`,
    details: params.note || "",
    createdAt: serverTimestamp(),
  });
}

export async function assignUnitToIncident(params: {
  incident: IncidentRecord;
  unit: ResponseUnit;
  actorUid: string;
  actorRole: UserRole;
}): Promise<void> {
  const updatedUnits = Array.from(new Set([...params.incident.assignedUnitIds, params.unit.id]));
  const updatedResponders = Array.from(
    new Set([...params.incident.assignedResponderUids, ...(params.unit.memberUids || [])])
  );
  const nextStatus: IncidentStatus =
    params.incident.status === "reported" ||
    params.incident.status === "Pending" ||
    params.incident.status === "verified"
      ? "assigned"
      : params.incident.status;

  await updateDoc(doc(db, "emergencies", params.incident.id), {
    assignedUnitIds: updatedUnits,
    assignedResponderUids: updatedResponders,
    status: nextStatus,
    updatedAt: serverTimestamp(),
  });

  await updateDoc(doc(db, "units", params.unit.id), {
    status: "dispatched",
    currentIncidentId: params.incident.id,
    updatedAt: serverTimestamp(),
  });

  await recordTimelineEvent(params.incident.id, {
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    action: "unit_assigned",
    fromState: params.incident.status,
    toState: nextStatus,
    note: `Dispatched unit ${params.unit.name} (${params.unit.type})`,
  });

  await addDoc(collection(db, "auditLogs"), {
    incidentId: params.incident.id,
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    action: "assign_unit",
    details: `Unit ${params.unit.id} (${params.unit.name}) assigned`,
    createdAt: serverTimestamp(),
  });
}

export async function mergeDuplicateIncident(params: {
  duplicateIncident: IncidentRecord;
  primaryIncident: IncidentRecord;
  actorUid: string;
  actorRole: UserRole;
}): Promise<void> {
  await updateDoc(doc(db, "emergencies", params.duplicateIncident.id), {
    mergedIntoId: params.primaryIncident.id,
    status: "closed",
    updatedAt: serverTimestamp(),
  });

  await updateDoc(doc(db, "emergencies", params.primaryIncident.id), {
    duplicateCount: (params.primaryIncident.duplicateCount || 0) + 1,
    peopleAffected: Math.max(
      params.primaryIncident.peopleAffected,
      params.duplicateIncident.peopleAffected
    ),
    updatedAt: serverTimestamp(),
  });

  await recordTimelineEvent(params.primaryIncident.id, {
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    action: "merged",
    note: `Merged duplicate report #${params.duplicateIncident.id.slice(0, 6)} into this incident`,
  });
}

export async function flagIncidentAbuse(
  incident: IncidentRecord,
  actorUid: string,
  actorRole: UserRole
): Promise<void> {
  await updateDoc(doc(db, "emergencies", incident.id), {
    abuseFlags: (incident.abuseFlags || 0) + 1,
    status: "false_alarm",
    updatedAt: serverTimestamp(),
  });

  await recordTimelineEvent(incident.id, {
    actorUid,
    actorRole,
    action: "abuse_flagged",
    fromState: incident.status,
    toState: "false_alarm",
    note: "Flagged as false alarm / abusive report",
  });

  await addDoc(collection(db, "auditLogs"), {
    incidentId: incident.id,
    actorUid,
    actorRole,
    action: "flag_abuse",
    details: `Reporter ${incident.reporterUid} flagged for false alarm`,
    createdAt: serverTimestamp(),
  });
}

export async function archiveIncidentReport(
  incidentId: string,
  actorUid: string,
  actorRole: UserRole
): Promise<void> {
  if (actorRole !== "admin") {
    throw new Error("Only administrators can archive reports.");
  }
  await updateDoc(doc(db, "emergencies", incidentId), {
    archived: true,
    updatedAt: serverTimestamp(),
  });
  await addDoc(collection(db, "auditLogs"), {
    incidentId,
    actorUid,
    actorRole,
    action: "archived",
    details: "Soft-deleted by administrator",
    createdAt: serverTimestamp(),
  });
}

export async function submitIncidentFeedback(
  incidentId: string,
  rating: number,
  feedback: string
): Promise<void> {
  await updateDoc(doc(db, "emergencies", incidentId), {
    rating,
    feedback: feedback.trim(),
    updatedAt: serverTimestamp(),
  });
}

// ============ RESPONSE UNITS MANAGEMENT ============
export function subscribeResponseUnits(
  onUpdate: (units: ResponseUnit[]) => void
): Unsubscribe {
  return onSnapshot(
    collection(db, "units"),
    (snap) => {
      const units: ResponseUnit[] = [];
      snap.forEach((d) => {
        const data = d.data();
        const coords: LatLng = data.coordinates?.latitude
          ? { lat: data.coordinates.latitude, lng: data.coordinates.longitude }
          : { lat: Number(data.lat || 28.6139), lng: Number(data.lng || 77.209) };
        units.push({
          id: d.id,
          name: String(data.name || d.id),
          type: (data.type as UnitType) || "Rescue",
          status: (data.status as UnitStatus) || "available",
          coordinates: coords,
          geohash: String(data.geohash || encodeGeohash(coords.lat, coords.lng)),
          capacity: Number(data.capacity || 4),
          contactPhone: String(data.contactPhone || "112"),
          currentIncidentId: data.currentIncidentId ? String(data.currentIncidentId) : null,
          memberUids: Array.isArray(data.memberUids) ? data.memberUids : [],
          updatedAtMs: parseTimestampMs(data.updatedAt, Date.now()),
        });
      });
      onUpdate(units);
    },
    () => {
      // Citizen role does not read /units
      onUpdate([]);
    }
  );
}

export async function createResponseUnit(input: {
  name: string;
  type: UnitType;
  lat: number;
  lng: number;
  capacity: number;
  contactPhone: string;
}): Promise<void> {
  await addDoc(collection(db, "units"), {
    name: input.name.trim(),
    type: input.type,
    status: "available",
    coordinates: new GeoPoint(input.lat, input.lng),
    geohash: encodeGeohash(input.lat, input.lng),
    capacity: input.capacity,
    contactPhone: input.contactPhone.trim(),
    currentIncidentId: null,
    memberUids: [],
    updatedAt: serverTimestamp(),
  });
}

export async function fetchAllUsersForAdmin(): Promise<UserProfile[]> {
  const snap = await getDocs(collection(db, "users"));
  const users: UserProfile[] = [];
  snap.forEach((d) => {
    const data = d.data();
    users.push({
      uid: d.id,
      email: String(data.email || ""),
      displayName: String(data.displayName || d.id),
      role: (data.role as UserRole) || "citizen",
      unitId: data.unitId ? String(data.unitId) : null,
      preferredLang: data.preferredLang === "hi" ? "hi" : "en",
      fcmTokens: [],
      emailVerified: Boolean(data.emailVerified),
      mfaEnrolled: Boolean(data.mfaEnrolled),
      createdAtMs: parseTimestampMs(data.createdAt, Date.now()),
    });
  });
  return users;
}

export async function updateUserRoleAsAdmin(
  targetUid: string,
  newRole: UserRole,
  actorUid: string
): Promise<void> {
  await updateDoc(doc(db, "users", targetUid), {
    role: newRole,
    updatedAt: serverTimestamp(),
  });
  await addDoc(collection(db, "auditLogs"), {
    incidentId: "USER_ROLE_CHANGE",
    actorUid,
    actorRole: "admin",
    action: "set_user_role",
    details: `Updated user ${targetUid} to role ${newRole}`,
    createdAt: serverTimestamp(),
  });
}
