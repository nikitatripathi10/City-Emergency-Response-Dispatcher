export type UserRole = "citizen" | "responder" | "dispatcher" | "admin";

export type EmergencyType = "Fire" | "Medical" | "Accident" | "Police" | "Minor";

export type ReportedSeverity = "critical" | "high" | "moderate" | "low";

export type PriorityLevel = "Critical" | "High" | "Medium" | "Low";

export type IncidentStatus =
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

export type VulnerabilityFlag = "children" | "elderly" | "hazmat" | "trapped";

export type UnitType = "Fire" | "Medical" | "Police" | "Rescue";

export type UnitStatus = "available" | "dispatched" | "en_route" | "on_scene" | "offline";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface IncidentMedia {
  url: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
}

export interface IncidentRecord {
  id: string;
  uid: string;
  reporterUid: string;
  reporterEmail?: string;
  type: EmergencyType;
  reportedSeverity: ReportedSeverity;
  peopleAffected: number;
  vulnerabilityFlags: VulnerabilityFlag[];
  location: string;
  desc: string;
  coordinates: LatLng | null;
  geohash: string;
  distance: number; // km from control room (server/Haversine computed)
  priorityScore: number;
  priority: PriorityLevel;
  weight: number;
  status: IncidentStatus;
  assignedUnitIds: string[];
  assignedResponderUids: string[];
  mergedIntoId: string | null;
  duplicateCount: number;
  img: string; // Primary image URL for backwards compatibility
  media: IncidentMedia[];
  rating: number | null;
  feedback: string;
  abuseFlags: number;
  archived: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  resolvedAtMs: number | null;
}

export interface TimelineEvent {
  id: string;
  incidentId: string;
  actorUid: string;
  actorRole: UserRole;
  action:
    | "created"
    | "status_change"
    | "unit_assigned"
    | "priority_escalated"
    | "merged"
    | "archived"
    | "abuse_flagged"
    | "feedback_submitted";
  fromState?: IncidentStatus;
  toState?: IncidentStatus;
  note: string;
  createdAtMs: number;
}

export interface ResponseUnit {
  id: string;
  name: string;
  type: UnitType;
  status: UnitStatus;
  coordinates: LatLng;
  geohash: string;
  capacity: number;
  contactPhone: string;
  currentIncidentId: string | null;
  memberUids: string[];
  updatedAtMs: number;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  unitId: string | null;
  preferredLang: "en" | "hi";
  fcmTokens: string[];
  emailVerified: boolean;
  mfaEnrolled: boolean;
  createdAtMs: number;
}

export interface AuditLogEntry {
  id?: string;
  incidentId: string;
  actorUid: string;
  actorRole: UserRole;
  action: string;
  details: string;
  createdAtMs: number;
}

export interface GeocodingResult {
  displayName: string;
  mainText: string;
  subText: string;
  lat: number;
  lng: number;
  provider: "photon" | "mapbox" | "google" | "nominatim";
}

export interface OfflineQueuedReport {
  localId: string;
  type: EmergencyType;
  reportedSeverity: ReportedSeverity;
  peopleAffected: number;
  vulnerabilityFlags: VulnerabilityFlag[];
  location: string;
  desc: string;
  coordinates: LatLng | null;
  queuedAtMs: number;
}
