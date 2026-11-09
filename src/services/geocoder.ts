import type { GeocodingResult } from "../types/models";

const cache = new Map<string, GeocodingResult[]>();

export async function searchLocations(queryText: string, lang = "en"): Promise<GeocodingResult[]> {
  const trimmed = queryText.trim();
  if (trimmed.length < 2) return [];

  const cacheKey = `${lang}:${trimmed.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};
  const proxyUrl = env.VITE_GEOCODER_PROXY_URL || "/api/geocode";

  // 1. Try Cloud Function geocoding proxy first (keeps Mapbox/Google keys server-side)
  try {
    const proxyRes = await fetch(
      `${proxyUrl}?q=${encodeURIComponent(trimmed)}&lang=${encodeURIComponent(lang)}&limit=6`,
      { headers: { Accept: "application/json" } }
    );
    if (proxyRes.ok) {
      const contentType = proxyRes.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = (await proxyRes.json()) as { results?: GeocodingResult[] };
        if (Array.isArray(payload.results)) {
          cache.set(cacheKey, payload.results);
          return payload.results;
        }
      }
    }
  } catch {
    // Fall back to direct Photon geocoder when running without proxy function
  }

  // 2. Fallback to Photon (Komoot OpenStreetMap geocoder designed for search-as-you-type autocomplete)
  const photonRes = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(trimmed)}&limit=6&lang=${lang === "hi" ? "en" : lang}`
  );
  if (!photonRes.ok) {
    throw new Error(`Geocoder HTTP ${photonRes.status}`);
  }
  const data = (await photonRes.json()) as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: {
        name?: string;
        street?: string;
        city?: string;
        district?: string;
        state?: string;
        country?: string;
      };
    }>;
  };

  const results: GeocodingResult[] = (data.features || [])
    .map((f): GeocodingResult | null => {
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) return null;
      const [lng, lat] = coords;
      const p = f.properties || {};
      const mainText = p.name || p.street || p.city || trimmed;
      const subParts = [p.district, p.city, p.state, p.country].filter(
        (part): part is string => Boolean(part && part !== mainText)
      );
      const subText = subParts.slice(0, 3).join(", ");
      const displayName = subText ? `${mainText}, ${subText}` : mainText;
      return {
        displayName,
        mainText,
        subText,
        lat: Number(lat),
        lng: Number(lng),
        provider: "photon",
      };
    })
    .filter((item): item is GeocodingResult => item !== null);

  if (cache.size > 100) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(cacheKey, results);
  return results;
}
