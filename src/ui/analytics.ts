import type { IncidentRecord } from "../types/models";
import { formatNumber } from "../i18n";

export interface AnalyticsSummary {
  totalIncidents: number;
  resolvedCount: number;
  resolutionRatePct: number;
  avgResponseMinutes: number;
  avgRating: number;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
}

export function computeAnalyticsSummary(incidents: IncidentRecord[]): AnalyticsSummary {
  const totalIncidents = incidents.length;
  const resolved = incidents.filter((e) =>
    ["resolved", "Resolved", "closed"].includes(e.status)
  );
  const resolvedCount = resolved.length;
  const resolutionRatePct =
    totalIncidents > 0 ? Math.round((resolvedCount / totalIncidents) * 100) : 0;

  // Compute average time to resolution (in minutes) for incidents with resolvedAtMs
  const durationsMins = resolved
    .filter((e) => e.resolvedAtMs && e.createdAtMs && e.resolvedAtMs >= e.createdAtMs)
    .map((e) => ((e.resolvedAtMs as number) - e.createdAtMs) / 60000);
  const avgResponseMinutes =
    durationsMins.length > 0
      ? Math.round(
          (durationsMins.reduce((sum, val) => sum + val, 0) / durationsMins.length) * 10
        ) / 10
      : 0;

  const rated = incidents.filter((e) => typeof e.rating === "number" && e.rating >= 1);
  const avgRating =
    rated.length > 0
      ? Math.round(
          (rated.reduce((sum, e) => sum + (e.rating || 0), 0) / rated.length) * 10
        ) / 10
      : 0;

  const byType: Record<string, number> = {
    Fire: 0,
    Medical: 0,
    Accident: 0,
    Police: 0,
    Minor: 0,
  };
  const byPriority: Record<string, number> = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
  };

  for (const inc of incidents) {
    byType[inc.type] = (byType[inc.type] || 0) + 1;
    byPriority[inc.priority] = (byPriority[inc.priority] || 0) + 1;
  }

  return {
    totalIncidents,
    resolvedCount,
    resolutionRatePct,
    avgResponseMinutes,
    avgRating,
    byType,
    byPriority,
  };
}

export function renderAnalyticsPanel(incidents: IncidentRecord[]): void {
  const container = document.getElementById("analyticsContent");
  if (!container) return;
  container.replaceChildren();

  const summary = computeAnalyticsSummary(incidents);

  const kpiGrid = document.createElement("div");
  kpiGrid.className = "analytics-kpi-grid";

  const kpis = [
    { label: "Total Incidents", val: formatNumber(summary.totalIncidents, 0) },
    { label: "Resolution Rate", val: `${formatNumber(summary.resolutionRatePct, 0)}%` },
    {
      label: "Avg Resolution Time",
      val: summary.avgResponseMinutes > 0 ? `${formatNumber(summary.avgResponseMinutes, 1)} min` : "—",
    },
    {
      label: "Avg Citizen Rating",
      val: summary.avgRating > 0 ? `⭐ ${formatNumber(summary.avgRating, 1)} / 5` : "—",
    },
  ];

  kpis.forEach((k) => {
    const box = document.createElement("div");
    box.className = "kpi-card";
    const valDiv = document.createElement("div");
    valDiv.className = "kpi-val";
    valDiv.textContent = k.val;
    const lblDiv = document.createElement("div");
    lblDiv.className = "kpi-label";
    lblDiv.textContent = k.label;
    box.append(valDiv, lblDiv);
    kpiGrid.appendChild(box);
  });

  const barWrap = document.createElement("div");
  barWrap.className = "analytics-bars";
  Object.entries(summary.byType).forEach(([type, count]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "bar-name";
    nameSpan.textContent = type;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = `bar-fill bar-${type.toLowerCase()}`;
    const pct = summary.totalIncidents > 0 ? Math.round((count / summary.totalIncidents) * 100) : 0;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const countSpan = document.createElement("span");
    countSpan.className = "bar-count";
    countSpan.textContent = `${count} (${pct}%)`;
    row.append(nameSpan, track, countSpan);
    barWrap.appendChild(row);
  });

  container.append(kpiGrid, barWrap);
}
