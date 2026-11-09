import L from "leaflet";
import type { IncidentRecord, LatLng, ResponseUnit } from "../types/models";
import { getControlRoomCoords } from "../utils/geo";

let pickerMap: L.Map | null = null;
let pickerMarker: L.Marker | null = null;
let operationsMap: L.Map | null = null;
let operationsLayerGroup: L.LayerGroup | null = null;

const TYPE_HEX: Record<string, string> = {
  Fire: "#ff4500",
  Medical: "#00e676",
  Accident: "#ff9800",
  Police: "#2979ff",
  Minor: "#ab47bc",
};

export function renderLocationPickerMap(
  coords: LatLng,
  label: string,
  onPinMoved?: (newCoords: LatLng) => void
): void {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;
  mapEl.classList.remove("hidden");

  if (!pickerMap) {
    pickerMap = L.map("map").setView([coords.lat, coords.lng], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(pickerMap);
  } else {
    pickerMap.setView([coords.lat, coords.lng], 15);
  }

  if (pickerMarker) {
    pickerMarker.remove();
  }

  const popupNode = document.createElement("div");
  popupNode.textContent = `📍 ${label} (Drag pin to refine)`;

  pickerMarker = L.marker([coords.lat, coords.lng], { draggable: true })
    .addTo(pickerMap)
    .bindPopup(popupNode)
    .openPopup();

  pickerMarker.on("dragend", () => {
    if (!pickerMarker) return;
    const pos = pickerMarker.getLatLng();
    if (onPinMoved) {
      onPinMoved({
        lat: Math.round(pos.lat * 1000000) / 1000000,
        lng: Math.round(pos.lng * 1000000) / 1000000,
      });
    }
  });

  setTimeout(() => pickerMap?.invalidateSize(), 120);
}

export function renderOperationsClusterMap(
  incidents: IncidentRecord[],
  units: ResponseUnit[]
): void {
  const container = document.getElementById("operationsMap");
  if (!container) return;

  const center = getControlRoomCoords();
  if (!operationsMap) {
    operationsMap = L.map("operationsMap").setView([center.lat, center.lng], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(operationsMap);
    operationsLayerGroup = L.layerGroup().addTo(operationsMap);
  }

  if (!operationsLayerGroup) return;
  operationsLayerGroup.clearLayers();

  // Control Room marker
  const crPopup = document.createElement("div");
  crPopup.textContent = "🏢 Central Dispatch Control Room";
  L.circleMarker([center.lat, center.lng], {
    radius: 9,
    color: "#38bdf8",
    fillColor: "#0ea5e9",
    fillOpacity: 0.9,
    weight: 2,
  })
    .bindPopup(crPopup)
    .addTo(operationsLayerGroup);

  const zoom = operationsMap.getZoom() || 11;
  // Grid-based spatial clustering when zoomed out (< 13)
  const cellSizeDeg = zoom < 11 ? 0.08 : zoom < 13 ? 0.03 : 0;

  const activeIncidents = incidents.filter(
    (inc) =>
      inc.coordinates &&
      !inc.archived &&
      !["resolved", "Resolved", "closed", "cancelled", "false_alarm"].includes(inc.status)
  );

  if (cellSizeDeg > 0) {
    const clusters = new Map<string, IncidentRecord[]>();
    for (const inc of activeIncidents) {
      if (!inc.coordinates) continue;
      const gx = Math.floor(inc.coordinates.lat / cellSizeDeg);
      const gy = Math.floor(inc.coordinates.lng / cellSizeDeg);
      const key = `${gx}:${gy}`;
      const bucket = clusters.get(key) || [];
      bucket.push(inc);
      clusters.set(key, bucket);
    }

    clusters.forEach((group) => {
      if (group.length === 1) {
        addSingleIncidentMarker(group[0], operationsLayerGroup!);
      } else {
        const avgLat =
          group.reduce((s, i) => s + (i.coordinates?.lat || 0), 0) / group.length;
        const avgLng =
          group.reduce((s, i) => s + (i.coordinates?.lng || 0), 0) / group.length;

        const popup = document.createElement("div");
        popup.textContent = `⚡ ${group.length} Active Incidents in Cluster`;

        L.circleMarker([avgLat, avgLng], {
          radius: Math.min(24, 12 + group.length * 2),
          color: "#f43f5e",
          fillColor: "#e11d48",
          fillOpacity: 0.85,
          weight: 3,
        })
          .bindPopup(popup)
          .addTo(operationsLayerGroup!);
      }
    });
  } else {
    activeIncidents.forEach((inc) => addSingleIncidentMarker(inc, operationsLayerGroup!));
  }

  // Render active response units
  units.forEach((u) => {
    const uPopup = document.createElement("div");
    uPopup.textContent = `🚓 Unit ${u.name} (${u.type}) — ${u.status.toUpperCase()}`;
    L.circleMarker([u.coordinates.lat, u.coordinates.lng], {
      radius: 7,
      color: "#22c55e",
      fillColor: u.status === "available" ? "#10b981" : "#eab308",
      fillOpacity: 0.9,
      weight: 2,
    })
      .bindPopup(uPopup)
      .addTo(operationsLayerGroup!);
  });
}

function addSingleIncidentMarker(inc: IncidentRecord, layer: L.LayerGroup): void {
  if (!inc.coordinates) return;
  const color = TYPE_HEX[inc.type] || "#38bdf8";
  const popup = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${inc.type} (${inc.priority})`;
  const sub = document.createElement("div");
  sub.textContent = `${inc.location} · Status: ${inc.status}`;
  popup.append(title, sub);

  L.circleMarker([inc.coordinates.lat, inc.coordinates.lng], {
    radius: inc.priority === "Critical" ? 11 : 8,
    color,
    fillColor: color,
    fillOpacity: 0.78,
    weight: 2,
  })
    .bindPopup(popup)
    .addTo(layer);
}
