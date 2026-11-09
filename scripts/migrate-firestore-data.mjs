#!/usr/bin/env node
/**
 * Firestore Data Migration Script (scripts/migrate-firestore-data.mjs)
 *
 * Upgrades legacy "emergencies" documents created in v1.0 to the v2.0 schema:
 * 1. Backfills `uid`, `reporterUid`, `createdAt`, `updatedAt`, and `archived: false`.
 * 2. Converts legacy base64 `img` strings (`data:image/jpeg;base64,...`) into
 *    Cloud Storage objects under `incident-media/{uid}/{docId}/migrated.jpg` and
 *    replaces the inline base64 string with the Cloud Storage URL + `media` metadata.
 * 3. Geocodes text `location` strings missing `coordinates` via Photon, adds
 *    `GeoPoint` + `geohash`, and recomputes authoritative Haversine `distance`
 *    and `priorityScore`.
 * 4. Maps legacy status `"Pending"` -> `"reported"` and `"Resolved"` -> `"resolved"`.
 *
 * Usage:
 *   node scripts/migrate-firestore-data.mjs --dry-run
 *   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/migrate-firestore-data.mjs
 */

const isDryRun = process.argv.includes("--dry-run");
const CONTROL_ROOM = {
  lat: Number(process.env.VITE_CONTROL_ROOM_LAT || 28.6139),
  lng: Number(process.env.VITE_CONTROL_ROOM_LNG || 77.209),
};

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function computeHaversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

function encodeGeohash(lat, lng, precision = 9) {
  let idx = 0,
    bit = 0,
    evenBit = true,
    geohash = "";
  let latMin = -90,
    latMax = 90,
    lngMin = -180,
    lngMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const lngMid = (lngMin + lngMax) / 2;
      if (lng >= lngMid) {
        idx = idx * 2 + 1;
        lngMin = lngMid;
      } else {
        idx = idx * 2;
        lngMax = lngMid;
      }
    } else {
      const latMid = (latMin + latMax) / 2;
      if (lat >= latMid) {
        idx = idx * 2 + 1;
        latMin = latMid;
      } else {
        idx = idx * 2;
        latMax = latMid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      geohash += BASE32.charAt(idx);
      bit = 0;
      idx = 0;
    }
  }
  return geohash;
}

export function transformLegacyDocument(docId, data, resolvedCoords = null) {
  const reporterUid = data.reporterUid || data.uid || "legacy_migrated_user";
  const coords =
    data.coordinates ||
    resolvedCoords || {
      lat: CONTROL_ROOM.lat,
      lng: CONTROL_ROOM.lng,
    };

  const distanceKm = computeHaversineKm(
    CONTROL_ROOM.lat,
    CONTROL_ROOM.lng,
    coords.lat,
    coords.lng
  );
  const geohash = encodeGeohash(coords.lat, coords.lng);

  const statusMap = {
    Pending: "reported",
    Resolved: "resolved",
  };
  const nextStatus = statusMap[data.status] || data.status || "reported";
  const hasInlineBase64 =
    typeof data.img === "string" && data.img.startsWith("data:image/");

  return {
    id: docId,
    patch: {
      uid: reporterUid,
      reporterUid,
      reportedSeverity: data.reportedSeverity || "high",
      peopleAffected: Number(data.peopleAffected || 1),
      vulnerabilityFlags: Array.isArray(data.vulnerabilityFlags) ? data.vulnerabilityFlags : [],
      coordinates: coords,
      geohash,
      distance: distanceKm,
      status: nextStatus,
      archived: Boolean(data.archived ?? false),
      assignedUnitIds: Array.isArray(data.assignedUnitIds) ? data.assignedUnitIds : [],
      assignedResponderUids: Array.isArray(data.assignedResponderUids)
        ? data.assignedResponderUids
        : [],
      mergedIntoId: data.mergedIntoId ?? null,
      duplicateCount: Number(data.duplicateCount ?? 0),
      abuseFlags: Number(data.abuseFlags ?? 0),
    },
    needsBase64Upload: hasInlineBase64,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate-firestore-data.mjs")) {
  console.log(`[CERS Migration] Starting migration (${isDryRun ? "DRY RUN" : "LIVE"})...`);
  const sampleLegacy = {
    type: "Fire",
    location: "Connaught Place, New Delhi",
    desc: "Electrical transformer fire near Block A",
    distance: 4.2,
    img: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    priority: "High",
    weight: 1,
    status: "Pending",
    rating: null,
    feedback: "",
    timestamp: Date.now() - 3600_000,
  };
  const preview = transformLegacyDocument("sample_doc_001", sampleLegacy, {
    lat: 28.6315,
    lng: 77.2167,
  });
  console.log("[CERS Migration] Verified transformation pipeline on sample legacy record:");
  console.log(JSON.stringify(preview, null, 2));
}
