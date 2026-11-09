import type { LatLng, UnitType } from "../types/models";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function getControlRoomCoords(): LatLng {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};
  const lat = Number(env.VITE_CONTROL_ROOM_LAT || 28.6139);
  const lng = Number(env.VITE_CONTROL_ROOM_LNG || 77.209);
  return {
    lat: Number.isFinite(lat) ? lat : 28.6139,
    lng: Number.isFinite(lng) ? lng : 77.209,
  };
}

export function computeHaversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

export function encodeGeohash(lat: number, lng: number, precision = 9): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = "";
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

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

export function estimateEtaMinutes(distanceKm: number, unitType: UnitType): number {
  // Average urban emergency response speeds in km/h
  const speedsKmH: Record<UnitType, number> = {
    Police: 50,
    Medical: 45,
    Fire: 40,
    Rescue: 38,
  };
  const speed = speedsKmH[unitType] || 42;
  const travelMins = (Math.max(0.2, distanceKm) / speed) * 60;
  return Math.max(1, Math.round(travelMins + 1.5)); // +1.5m turnout time
}
