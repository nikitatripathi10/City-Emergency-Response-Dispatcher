import { onAuthStateChanged, type User } from "firebase/auth";
import type { Unsubscribe } from "firebase/firestore";
import { auth } from "./db/firebase";
import {
  checkReportRateLimit,
  deleteMyAccountAndData,
  recordReportSubmissionTimestamp,
  resolveUserProfile,
  signInOrSignUp,
  signOutUser,
  triggerPasswordReset,
} from "./auth/authManager";
import {
  archiveIncidentReport,
  assignUnitToIncident,
  createIncidentReport,
  createResponseUnit,
  fetchAllUsersForAdmin,
  fetchIncidentTimeline,
  flagIncidentAbuse,
  mergeDuplicateIncident,
  submitIncidentFeedback,
  subscribeIncidents,
  subscribeResponseUnits,
  transitionIncidentWorkflow,
  updateUserRoleAsAdmin,
} from "./db/repository";
import {
  enqueueOfflineReport,
  getOfflineQueue,
  removeOfflineQueuedReport,
} from "./db/offlineQueue";
import { searchLocations } from "./services/geocoder";
import { renderLocationPickerMap, renderOperationsClusterMap } from "./map/mapManager";
import {
  requestBrowserNotificationPermission,
  sendLocalBrowserNotification,
  showConfirmModal,
  showToast,
} from "./ui/notifications";
import { renderAnalyticsPanel } from "./ui/analytics";
import {
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  getLocale,
  setLocale,
  t,
} from "./i18n";
import { computeHaversineKm, getControlRoomCoords } from "./utils/geo";
import {
  canTransitionState,
  isDuplicateIncident,
  recommendUnitsForIncident,
  VALID_STATE_TRANSITIONS,
} from "./utils/priority";
import {
  exportIncidentsToCsv,
  isValidImageSrc,
  validateImageFile,
  validateIncidentInput,
} from "./utils/validators";
import { initObservability, logStructuredEvent } from "./utils/observability";
import type {
  EmergencyType,
  GeocodingResult,
  IncidentRecord,
  IncidentStatus,
  LatLng,
  ReportedSeverity,
  ResponseUnit,
  UnitType,
  UserProfile,
  UserRole,
  VulnerabilityFlag,
} from "./types/models";

// ============ APPLICATION STATE ============
let emergencies: IncidentRecord[] = [];
let responseUnits: ResponseUnit[] = [];
let currentUser: User | null = null;
let currentProfile: UserProfile | null = null;
let currentUserRole: UserRole = "citizen";
let signupMode = false;
let selectedCoords: LatLng | null = null;
let ddItems: GeocodingResult[] = [];
let ddActiveIdx = -1;
let ddDebounce: ReturnType<typeof setTimeout> | null = null;
let dashFilter = "all";
let searchQuery = "";
let sortBy: "priority" | "newest" | "distance" = "priority";
let pageSize = 25;
let unsubscribeEmergencies: Unsubscribe | null = null;
let unsubscribeUnits: Unsubscribe | null = null;
const previousStatusMap = new Map<string, IncidentStatus>();

const TYPE_COLORS: Record<EmergencyType, { hex: string; emoji: string; class: string }> = {
  Fire: { hex: "#ff4500", emoji: "🔥", class: "banner-fire" },
  Medical: { hex: "#00e676", emoji: "🏥", class: "banner-medical" },
  Accident: { hex: "#ff9800", emoji: "🚗", class: "banner-accident" },
  Police: { hex: "#2979ff", emoji: "🚔", class: "banner-police" },
  Minor: { hex: "#ab47bc", emoji: "⚠️", class: "banner-minor" },
};

// ============ AUTH & SESSION LIFECYCLE ============
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    currentProfile = await resolveUserProfile(user);
    currentUserRole = currentProfile.role;

    const roleLabel = document.getElementById("roleLabel");
    if (roleLabel) roleLabel.textContent = currentUserRole.toUpperCase();

    document.getElementById("authPage")?.classList.add("hidden");
    document.getElementById("app")?.classList.remove("hidden");

    updateRoleVisibility();
    applyTranslations();
    startRealtimeSubscriptions();
    void syncOfflineQueuedReports();
  } else {
    currentUser = null;
    currentProfile = null;
    currentUserRole = "citizen";
    stopRealtimeSubscriptions();
    emergencies = [];
    responseUnits = [];
    document.getElementById("authPage")?.classList.remove("hidden");
    document.getElementById("app")?.classList.add("hidden");
  }
});

function updateRoleVisibility(): void {
  const isStaff = ["responder", "dispatcher", "admin"].includes(currentUserRole);
  const isDispatcherOrAdmin = ["dispatcher", "admin"].includes(currentUserRole);
  const isAdmin = currentUserRole === "admin";

  document.getElementById("operationsMapSection")?.classList.toggle("hidden", !isStaff);
  document.getElementById("unitsSection")?.classList.toggle("hidden", !isStaff);
  document.getElementById("createUnitForm")?.classList.toggle("hidden", !isDispatcherOrAdmin);
  document.getElementById("analyticsSection")?.classList.toggle("hidden", !isDispatcherOrAdmin);
  document.getElementById("adminUsersSection")?.classList.toggle("hidden", !isAdmin);

  if (isAdmin) {
    void loadAdminUsersTable();
  }
}

function startRealtimeSubscriptions(): void {
  stopRealtimeSubscriptions();
  if (!currentUser) return;

  unsubscribeEmergencies = subscribeIncidents(
    currentUser.uid,
    currentUserRole,
    pageSize,
    (list) => {
      // Detect status changes on citizen's own reports to trigger local notification
      list.forEach((inc) => {
        const prev = previousStatusMap.get(inc.id);
        if (prev && prev !== inc.status && inc.reporterUid === currentUser?.uid) {
          showToast(`Status update for your ${inc.type} report: ${inc.status}`, "info");
          sendLocalBrowserNotification(
            `CERS Incident Update (${inc.type})`,
            `Your report at ${inc.location} is now "${inc.status}".`
          );
        }
        previousStatusMap.set(inc.id, inc.status);
      });

      emergencies = list;
      updateStatusCounts();
      smartRender();
      if (["responder", "dispatcher", "admin"].includes(currentUserRole)) {
        renderOperationsClusterMap(emergencies, responseUnits);
      }
      if (["dispatcher", "admin"].includes(currentUserRole)) {
        renderAnalyticsPanel(emergencies);
      }
    },
    (err) => showToast(`Live sync error: ${err.message}`, "error")
  );

  if (["responder", "dispatcher", "admin"].includes(currentUserRole)) {
    unsubscribeUnits = subscribeResponseUnits((units) => {
      responseUnits = units;
      renderUnitsList();
      renderOperationsClusterMap(emergencies, responseUnits);
    });
  }
}

function stopRealtimeSubscriptions(): void {
  if (unsubscribeEmergencies) {
    unsubscribeEmergencies();
    unsubscribeEmergencies = null;
  }
  if (unsubscribeUnits) {
    unsubscribeUnits();
    unsubscribeUnits = null;
  }
}

// ============ OFFLINE QUEUE SYNC ============
async function syncOfflineQueuedReports(): Promise<void> {
  if (!currentUser || !navigator.onLine) return;
  const queue = getOfflineQueue();
  if (queue.length === 0) return;

  for (const item of queue) {
    try {
      await createIncidentReport({
        reporterUid: currentUser.uid,
        reporterEmail: currentUser.email || "",
        type: item.type,
        reportedSeverity: item.reportedSeverity,
        peopleAffected: item.peopleAffected,
        vulnerabilityFlags: item.vulnerabilityFlags,
        location: item.location,
        desc: item.desc,
        coordinates: item.coordinates,
      });
      removeOfflineQueuedReport(item.localId);
      showToast(`Synced offline ${item.type} report (${item.location}).`, "success");
    } catch {
      // Keep in queue for next online retry
    }
  }
}

// ============ AUTH HANDLERS ============
function toggleAuth(): void {
  signupMode = !signupMode;
  applyTranslations();
  const passInput = document.getElementById("password");
  if (passInput) {
    passInput.setAttribute("autocomplete", signupMode ? "new-password" : "current-password");
  }
}

async function handleAuthSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const email = (document.getElementById("username") as HTMLInputElement)?.value.trim() || "";
  const password = (document.getElementById("password") as HTMLInputElement)?.value || "";
  if (!email || !password) {
    showToast("Please enter both email and password.", "warning");
    return;
  }
  const btn = document.getElementById("authSubmitBtn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    await signInOrSignUp(email, password, signupMode);
    showToast(
      signupMode
        ? "Account created! Verification email sent."
        : "Signed in to City Emergency Response.",
      "success"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(`${signupMode ? "Signup" : "Login"} Error: ${msg}`, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handlePasswordReset(): Promise<void> {
  const email = (document.getElementById("username") as HTMLInputElement)?.value.trim() || "";
  if (!email) {
    showToast("Enter your email address above first to receive a password reset link.", "warning");
    return;
  }
  try {
    await triggerPasswordReset(email);
    showToast(`Password reset email sent to ${email}.`, "success");
  } catch (err) {
    showToast(`Reset error: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

// ============ LOCATION AUTOCOMPLETE & GEOLOCATION ============
function setDropdownMessage(text: string, isError = false): void {
  const dd = document.getElementById("locationDropdown");
  if (!dd) return;
  dd.replaceChildren();
  const msg = document.createElement("div");
  msg.className = "dd-loading";
  if (isError) msg.style.color = "#f87171";
  msg.textContent = text;
  dd.appendChild(msg);
  dd.classList.remove("hidden");
  document.getElementById("location")?.setAttribute("aria-expanded", "true");
}

function handleLocationInput(e: Event): void {
  const q = (e.target as HTMLInputElement).value.trim();
  if (q.length < 2) {
    closeDropdown();
    return;
  }
  if (ddDebounce) clearTimeout(ddDebounce);
  ddDebounce = setTimeout(async () => {
    setDropdownMessage("🔍 Searching...");
    try {
      ddItems = await searchLocations(q, getLocale());
      ddActiveIdx = -1;
      renderDropdown(ddItems);
    } catch {
      setDropdownMessage("Geocoder connection error", true);
    }
  }, 300);
}

function renderDropdown(results: GeocodingResult[]): void {
  const dd = document.getElementById("locationDropdown");
  if (!dd) return;
  dd.replaceChildren();

  if (!results.length) {
    setDropdownMessage("No places found");
    return;
  }

  results.forEach((place, idx) => {
    const div = document.createElement("div");
    div.className = "dd-item";
    div.setAttribute("role", "option");
    div.dataset.idx = String(idx);

    const iconSpan = document.createElement("span");
    iconSpan.className = "dd-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.textContent = "📍";

    const textWrap = document.createElement("div");
    const mainDiv = document.createElement("div");
    mainDiv.className = "dd-main";
    mainDiv.textContent = place.mainText;
    textWrap.appendChild(mainDiv);

    if (place.subText) {
      const subDiv = document.createElement("div");
      subDiv.className = "dd-sub";
      subDiv.textContent = place.subText;
      textWrap.appendChild(subDiv);
    }

    div.append(iconSpan, textWrap);
    div.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      selectLocation(idx);
    });
    dd.appendChild(div);
  });

  dd.classList.remove("hidden");
  document.getElementById("location")?.setAttribute("aria-expanded", "true");
}

function selectLocation(idx: number): void {
  const place = ddItems[idx];
  if (!place) return;
  const locInput = document.getElementById("location") as HTMLInputElement | null;
  if (locInput) locInput.value = place.displayName;
  selectedCoords = { lat: place.lat, lng: place.lng };
  updateComputedDistanceDisplay(selectedCoords);
  closeDropdown();
  renderLocationPickerMap(selectedCoords, place.displayName, (newCoords) => {
    selectedCoords = newCoords;
    updateComputedDistanceDisplay(newCoords);
  });
}

function updateComputedDistanceDisplay(coords: LatLng): void {
  const cr = getControlRoomCoords();
  const distKm = computeHaversineKm(cr.lat, cr.lng, coords.lat, coords.lng);
  const distInput = document.getElementById("distance") as HTMLInputElement | null;
  if (distInput) {
    distInput.value = String(distKm);
  }
}

function handleUseMyLocation(): void {
  if (!("geolocation" in navigator)) {
    showToast("Geolocation is not supported by your browser.", "warning");
    return;
  }
  showToast("Acquiring GPS coordinates...", "info");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const coords: LatLng = {
        lat: Math.round(pos.coords.latitude * 1000000) / 1000000,
        lng: Math.round(pos.coords.longitude * 1000000) / 1000000,
      };
      selectedCoords = coords;
      const locInput = document.getElementById("location") as HTMLInputElement | null;
      const label = `GPS (${coords.lat}, ${coords.lng})`;
      if (locInput && !locInput.value.trim()) {
        locInput.value = label;
      }
      updateComputedDistanceDisplay(coords);
      renderLocationPickerMap(coords, label, (movedCoords) => {
        selectedCoords = movedCoords;
        updateComputedDistanceDisplay(movedCoords);
      });
      showToast("GPS coordinates locked. Drag the map pin to fine-tune.", "success");
    },
    (err) => {
      showToast(`Location access error: ${err.message}`, "error");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function closeDropdown(): void {
  const dd = document.getElementById("locationDropdown");
  if (dd) {
    dd.classList.add("hidden");
    dd.replaceChildren();
  }
  document.getElementById("location")?.setAttribute("aria-expanded", "false");
  ddItems = [];
  ddActiveIdx = -1;
}

// ============ REPORT SUBMISSION ============
async function handleReportSubmit(e: Event): Promise<void> {
  e.preventDefault();
  if (!currentUser) {
    showToast("You must be signed in to report an emergency.", "warning");
    return;
  }

  const consentEl = document.getElementById("consentCheck") as HTMLInputElement | null;
  if (consentEl && !consentEl.checked) {
    showToast("Please confirm that this emergency report is genuine.", "warning");
    return;
  }

  const rateCheck = checkReportRateLimit();
  if (!rateCheck.allowed) {
    showToast(
      `Rate limit reached. Please wait ${rateCheck.retryAfterSec}s before submitting another report.`,
      "warning"
    );
    return;
  }

  const type = ((document.getElementById("type") as HTMLInputElement)?.value ||
    "Fire") as EmergencyType;
  const reportedSeverity = ((
    document.getElementById("reportedSeverity") as HTMLSelectElement
  )?.value || "high") as ReportedSeverity;
  const peopleAffected = Number(
    (document.getElementById("peopleAffected") as HTMLInputElement)?.value || 1
  );
  const location = (document.getElementById("location") as HTMLInputElement)?.value.trim() || "";
  const desc = (document.getElementById("description") as HTMLTextAreaElement)?.value.trim() || "";
  const distanceVal = Number(
    (document.getElementById("distance") as HTMLInputElement)?.value || 5
  );
  const fileInput = document.getElementById("image") as HTMLInputElement | null;
  const file = fileInput?.files?.[0] || null;

  const vulnerabilityFlags: VulnerabilityFlag[] = [];
  document.querySelectorAll<HTMLInputElement>(".vuln-checkbox:checked").forEach((cb) => {
    vulnerabilityFlags.push(cb.value as VulnerabilityFlag);
  });

  const validation = validateIncidentInput({
    type,
    reportedSeverity,
    location,
    desc,
    peopleAffected,
  });
  if (!validation.valid) {
    showToast(validation.error || "Invalid report fields.", "warning");
    return;
  }

  if (file) {
    const imgCheck = validateImageFile(file);
    if (!imgCheck.valid) {
      showToast(imgCheck.error || "Invalid image attachment.", "error");
      return;
    }
  }

  // Offline resilience: queue report locally if browser has no network connectivity
  if (!navigator.onLine) {
    enqueueOfflineReport({
      type,
      reportedSeverity,
      peopleAffected,
      vulnerabilityFlags,
      location,
      desc,
      coordinates: selectedCoords,
    });
    showToast(
      "You are offline. Report saved to offline queue and will auto-sync when connected.",
      "warning"
    );
    resetReportForm();
    return;
  }

  // Check for nearby duplicate active incident within 350m and 30 minutes
  const nearbyDup = emergencies.find((existing) =>
    isDuplicateIncident(
      { type, coordinates: selectedCoords, createdAtMs: Date.now() },
      existing
    )
  );
  if (nearbyDup) {
    const proceedAnyway = await showConfirmModal(
      "Similar Active Incident Nearby",
      `An active ${nearbyDup.type} report already exists near "${nearbyDup.location}". Submit as a new report anyway?`
    );
    if (!proceedAnyway) return;
  }

  const btn = document.getElementById("submitBtn") as HTMLButtonElement | null;
  const btnText = document.getElementById("submitBtnText");
  if (btnText) btnText.textContent = `⏳ ${t("submittingBtn")}`;
  if (btn) btn.disabled = true;

  try {
    await createIncidentReport({
      reporterUid: currentUser.uid,
      reporterEmail: currentUser.email || "",
      type,
      reportedSeverity,
      peopleAffected,
      vulnerabilityFlags,
      location,
      desc,
      coordinates: selectedCoords,
      manualDistanceKm: distanceVal,
      file,
    });
    recordReportSubmissionTimestamp();
    void requestBrowserNotificationPermission();
    showToast("Emergency reported! Dispatch has been notified live.", "success");
    logStructuredEvent("info", "incident_reported", { type, reportedSeverity });
    resetReportForm();
  } catch (err) {
    showToast(
      `Error submitting report: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
  } finally {
    if (btnText) btnText.textContent = `🚨 ${t("submitReportBtn")}`;
    if (btn) btn.disabled = false;
  }
}

function resetReportForm(): void {
  ["location", "description", "distance"].forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = "";
  });
  const peopleEl = document.getElementById("peopleAffected") as HTMLInputElement | null;
  if (peopleEl) peopleEl.value = "1";
  document.querySelectorAll<HTMLInputElement>(".vuln-checkbox").forEach((cb) => {
    cb.checked = false;
  });
  const fileInput = document.getElementById("image") as HTMLInputElement | null;
  if (fileInput) fileInput.value = "";
  const preview = document.getElementById("imagePreview");
  if (preview) {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
  }
  const fileLabel = document.getElementById("fileLabel");
  if (fileLabel) fileLabel.textContent = t("fileDropPrompt");
  selectedCoords = null;
  closeDropdown();
}

// ============ DASHBOARD RENDERING (SAFE DOM, PRESERVES INPUT) ============
function updateStatusCounts(): void {
  const counts: Record<EmergencyType, number> = {
    Fire: 0,
    Medical: 0,
    Accident: 0,
    Police: 0,
    Minor: 0,
  };
  emergencies.forEach((e) => {
    if (counts[e.type] !== undefined) counts[e.type]++;
  });
  const setTxt = (id: string, val: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = formatNumber(val, 0);
  };
  setTxt("count-fire", counts.Fire);
  setTxt("count-medical", counts.Medical);
  setTxt("count-accident", counts.Accident);
  setTxt("count-police", counts.Police);
  setTxt("count-minor", counts.Minor);
  setTxt("count-total", emergencies.length);
}

function getFilteredAndSortedIncidents(): IncidentRecord[] {
  const q = searchQuery.trim().toLowerCase();
  const filtered = emergencies.filter((e) => {
    const isResolved = ["resolved", "Resolved", "closed"].includes(e.status);
    if (dashFilter === "Pending" && isResolved) return false;
    if (dashFilter === "Resolved" && !isResolved) return false;
    if (q) {
      const hay = `${e.type} ${e.location} ${e.desc} ${e.status} ${e.priority}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    if (sortBy === "newest") return b.createdAtMs - a.createdAtMs;
    if (sortBy === "distance") return a.distance - b.distance;
    if (a.weight !== b.weight) return a.weight - b.weight;
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    return a.createdAtMs - b.createdAtMs;
  });
}

function buildFeedbackSection(incident: IncidentRecord): HTMLElement {
  const container = document.createElement("div");
  container.className = "feedbackDiv";
  container.dataset.rated = incident.rating ? "true" : "false";

  if (incident.rating) {
    const ratingP = document.createElement("p");
    ratingP.textContent = "⭐ Rating: ";
    const strong = document.createElement("strong");
    strong.textContent = `${incident.rating}/5`;
    ratingP.appendChild(strong);

    const commentP = document.createElement("p");
    commentP.style.cssText = "margin-top:4px;color:#94a3b8;font-size:12px";
    commentP.textContent = incident.feedback || "No feedback given";

    container.append(ratingP, commentP);
    return container;
  }

  const labelP = document.createElement("p");
  labelP.style.cssText = "font-weight:600;margin-bottom:6px";
  labelP.textContent = "Rate the response:";

  const select = document.createElement("select");
  select.className = "feedback-rating-select";
  select.setAttribute("aria-label", "Select response rating from 1 to 5 stars");

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Select rating";
  select.appendChild(defaultOpt);

  for (let stars = 1; stars <= 5; stars++) {
    const opt = document.createElement("option");
    opt.value = String(stars);
    opt.textContent = `${stars} ${"⭐".repeat(stars)}`;
    select.appendChild(opt);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "feedback-textarea";
  textarea.placeholder = "Write feedback...";
  textarea.rows = 2;
  textarea.style.marginTop = "6px";
  textarea.maxLength = 1000;

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.textContent = "Submit Feedback";
  submitBtn.addEventListener("click", async () => {
    const numRating = Number(select.value);
    if (!numRating || numRating < 1 || numRating > 5) {
      showToast("Please select a star rating (1 to 5) first.", "warning");
      return;
    }
    try {
      await submitIncidentFeedback(incident.id, numRating, textarea.value);
      showToast("Feedback submitted! Thank you.", "success");
    } catch (err) {
      showToast(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });

  container.append(labelP, select, textarea, submitBtn);
  return container;
}

function createEmergencyCardDOM(e: IncidentRecord): HTMLElement {
  const tc = TYPE_COLORS[e.type] || TYPE_COLORS.Minor;
  const badgeClass = String(e.priority || "low").toLowerCase();

  const card = document.createElement("article");
  card.className = "emergency-card";
  card.dataset.id = e.id;

  const banner = document.createElement("div");
  banner.className = `card-type-banner ${tc.class}`;
  card.appendChild(banner);

  if (isValidImageSrc(e.img)) {
    const imgEl = document.createElement("img");
    imgEl.src = e.img;
    imgEl.alt = `${e.type} incident attachment`;
    imgEl.loading = "lazy";
    card.appendChild(imgEl);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "type-banner-placeholder";
    placeholder.style.background = `linear-gradient(135deg, ${tc.hex}22, ${tc.hex}44)`;

    const emojiSpan = document.createElement("span");
    emojiSpan.style.fontSize = "2.5rem";
    emojiSpan.setAttribute("aria-hidden", "true");
    emojiSpan.textContent = tc.emoji;

    const labelSpan = document.createElement("span");
    labelSpan.style.cssText = `font-family:var(--font-head);font-size:1.1rem;font-weight:700;color:${tc.hex};letter-spacing:2px`;
    labelSpan.textContent = e.type.toUpperCase();

    placeholder.append(emojiSpan, labelSpan);
    card.appendChild(placeholder);
  }

  const content = document.createElement("div");
  content.className = "emergency-content";

  const header = document.createElement("div");
  header.className = "ec-header";

  const typeSpan = document.createElement("span");
  typeSpan.className = "ec-type";
  typeSpan.style.color = tc.hex;
  typeSpan.textContent = `${tc.emoji} ${e.type}`;

  const badgeSpan = document.createElement("span");
  badgeSpan.className = `badge ${badgeClass}`;
  badgeSpan.textContent = `${e.priority} (${e.priorityScore})`;

  header.append(typeSpan, badgeSpan);

  const locRow = document.createElement("div");
  locRow.className = "ec-info";
  const locIcon = document.createElement("span");
  locIcon.textContent = "📍";
  const locStrong = document.createElement("strong");
  locStrong.textContent = e.location;
  locRow.append(locIcon, locStrong);

  const distRow = document.createElement("div");
  distRow.className = "ec-info";
  distRow.textContent = `📏 ${formatNumber(e.distance, 1)} km · 👥 ${e.peopleAffected} affected`;

  const descP = document.createElement("p");
  descP.className = "ec-desc";
  descP.textContent = e.desc;

  const statusDiv = document.createElement("div");
  statusDiv.className = "status";

  const actionsSlot = document.createElement("div");
  actionsSlot.className = "card-actions-slot";

  const timelineBtn = document.createElement("button");
  timelineBtn.type = "button";
  timelineBtn.className = "lang-btn timeline-btn";
  timelineBtn.style.cssText = "width:100%;margin-bottom:6px";
  timelineBtn.textContent = "📜 View Incident Timeline";
  timelineBtn.addEventListener("click", () => void openTimelineModal(e));

  content.append(header, locRow, distRow, descP, statusDiv, timelineBtn, actionsSlot);
  card.appendChild(content);

  syncCardDynamicState(card, e);
  return card;
}

function syncCardDynamicState(card: HTMLElement, e: IncidentRecord): void {
  const isResolved = ["resolved", "Resolved", "closed"].includes(e.status);
  const isStaff = ["responder", "dispatcher", "admin"].includes(currentUserRole);
  const isDispatcherOrAdmin = ["dispatcher", "admin"].includes(currentUserRole);
  const isAdmin = currentUserRole === "admin";
  const isOwner = Boolean(currentUser && e.reporterUid === currentUser.uid);

  const statusDiv = card.querySelector(".status");
  if (statusDiv) {
    statusDiv.className = `status ${isResolved ? "status-resolved" : "status-pending"}`;
    statusDiv.replaceChildren();
    const icon = document.createElement("span");
    icon.textContent = isResolved ? "✅" : "🟡";
    const bold = document.createElement("b");
    bold.textContent = e.status.toUpperCase();
    const unitsNote = document.createElement("span");
    unitsNote.style.cssText = "font-size:11px;color:#94a3b8;margin-left:auto";
    if (e.assignedUnitIds.length > 0) {
      unitsNote.textContent = `🚓 ${e.assignedUnitIds.length} unit(s)`;
    }
    statusDiv.append(icon, document.createTextNode(" "), bold, unitsNote);
  }

  const slot = card.querySelector(".card-actions-slot") as HTMLElement | null;
  if (!slot) return;

  // If resolved/closed, only preserve or mount the feedback form without wiping active typing
  if (isResolved) {
    slot.querySelectorAll(".workflow-controls").forEach((n) => n.remove());
    if (isOwner || isStaff) {
      const existingFb = slot.querySelector(".feedbackDiv") as HTMLElement | null;
      const nowRated = e.rating ? "true" : "false";
      if (!existingFb) {
        slot.appendChild(buildFeedbackSection(e));
      } else if (existingFb.dataset.rated !== nowRated || nowRated === "true") {
        existingFb.replaceWith(buildFeedbackSection(e));
      }
    }
    ensureAdminArchiveBtn(slot, e, isAdmin);
    return;
  }

  slot.querySelector(".feedbackDiv")?.remove();
  slot.querySelectorAll(".workflow-controls").forEach((n) => n.remove());

  const wfBox = document.createElement("div");
  wfBox.className = "workflow-controls";

  // 1. State transition buttons valid for the current user's role
  const allowedNext = (VALID_STATE_TRANSITIONS[e.status] || []).filter((next) =>
    canTransitionState(e.status, next, currentUserRole, isOwner)
  );

  allowedNext.forEach((nextState) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = nextState === "cancelled" || nextState === "false_alarm" ? "deleteBtn" : "resolveBtn";
    btn.style.marginBottom = "6px";
    btn.textContent = `→ Mark as ${nextState.replace("_", " ").toUpperCase()}`;
    btn.addEventListener("click", async () => {
      if (!currentUser) return;
      try {
        await transitionIncidentWorkflow({
          incident: e,
          toState: nextState,
          actorUid: currentUser.uid,
          actorRole: currentUserRole,
        });
        showToast(`Incident transitioned to ${nextState}.`, "success");
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    });
    wfBox.appendChild(btn);
  });

  // 2. Dispatcher / Admin: Nearest Available Unit Recommendation & Assignment
  if (isDispatcherOrAdmin) {
    const recs = recommendUnitsForIncident(e, responseUnits);
    if (recs.length > 0) {
      const assignWrap = document.createElement("div");
      assignWrap.style.cssText = "display:flex;gap:6px;margin-bottom:6px";

      const unitSelect = document.createElement("select");
      unitSelect.setAttribute("aria-label", "Select response unit to dispatch");
      recs.forEach((u) => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.typeMatch ? "★ " : ""}${u.name} (${u.type} · ${u.distanceKm}km · ETA ${u.etaMinutes}m)`;
        unitSelect.appendChild(opt);
      });

      const dispatchBtn = document.createElement("button");
      dispatchBtn.type = "button";
      dispatchBtn.className = "resolveBtn";
      dispatchBtn.style.cssText = "width:auto;padding:8px 12px;margin-bottom:0;white-space:nowrap";
      dispatchBtn.textContent = "🚓 Dispatch";
      dispatchBtn.addEventListener("click", async () => {
        if (!currentUser) return;
        const chosen = responseUnits.find((u) => u.id === unitSelect.value);
        if (!chosen) return;
        try {
          await assignUnitToIncident({
            incident: e,
            unit: chosen,
            actorUid: currentUser.uid,
            actorRole: currentUserRole,
          });
          showToast(`Dispatched ${chosen.name} to ${e.location}.`, "success");
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), "error");
        }
      });

      assignWrap.append(unitSelect, dispatchBtn);
      wfBox.appendChild(assignWrap);
    }

    // 3. Duplicate Incident Detection & Merge suggestion
    const duplicateTarget = emergencies.find(
      (other) =>
        other.id !== e.id &&
        isDuplicateIncident(
          { type: e.type, coordinates: e.coordinates, createdAtMs: e.createdAtMs },
          other
        )
    );
    if (duplicateTarget) {
      const mergeBtn = document.createElement("button");
      mergeBtn.type = "button";
      mergeBtn.className = "lang-btn";
      mergeBtn.style.cssText = "width:100%;margin-bottom:6px;border-color:#f59e0b;color:#f59e0b";
      mergeBtn.textContent = `🔗 Merge Duplicate into #${duplicateTarget.id.slice(0, 5)}`;
      mergeBtn.addEventListener("click", async () => {
        if (!currentUser) return;
        try {
          await mergeDuplicateIncident({
            duplicateIncident: e,
            primaryIncident: duplicateTarget,
            actorUid: currentUser.uid,
            actorRole: currentUserRole,
          });
          showToast("Merged duplicate incident.", "info");
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), "error");
        }
      });
      wfBox.appendChild(mergeBtn);
    }

    // 4. Abuse / False Report Flag
    const flagBtn = document.createElement("button");
    flagBtn.type = "button";
    flagBtn.className = "deleteBtn";
    flagBtn.style.marginBottom = "6px";
    flagBtn.textContent = "🚩 Flag False Alarm / Abuse";
    flagBtn.addEventListener("click", async () => {
      if (!currentUser) return;
      const ok = await showConfirmModal(
        "Flag False Alarm",
        "Mark this incident as a false alarm and increment the abuse flag counter?"
      );
      if (!ok) return;
      try {
        await flagIncidentAbuse(e, currentUser.uid, currentUserRole);
        showToast("Incident flagged as false alarm.", "warning");
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    });
    wfBox.appendChild(flagBtn);
  }

  slot.appendChild(wfBox);
  ensureAdminArchiveBtn(slot, e, isAdmin);
}

function ensureAdminArchiveBtn(slot: HTMLElement, e: IncidentRecord, isAdmin: boolean): void {
  const existing = slot.querySelector(".admin-archive-btn");
  if (!isAdmin) {
    existing?.remove();
    return;
  }
  if (!existing) {
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "deleteBtn admin-archive-btn";
    archiveBtn.textContent = "🗑️ Archive Report (Admin)";
    archiveBtn.addEventListener("click", async () => {
      if (!currentUser) return;
      const ok = await showConfirmModal(
        "Archive Emergency Report",
        "Soft-delete this incident and record an immutable entry in auditLogs?"
      );
      if (!ok) return;
      try {
        await archiveIncidentReport(e.id, currentUser.uid, currentUserRole);
        showToast("Incident archived.", "info");
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    });
    slot.appendChild(archiveBtn);
  }
}

function smartRender(): void {
  const grid = document.getElementById("emergencyGrid");
  if (!grid) return;

  const filtered = getFilteredAndSortedIncidents();

  Array.from(grid.querySelectorAll<HTMLElement>(".emergency-card")).forEach((card) => {
    if (!emergencies.some((e) => e.id === card.dataset.id)) card.remove();
  });

  const existingEmptyMsg = grid.querySelector(".empty-state-msg");

  if (filtered.length === 0) {
    Array.from(grid.querySelectorAll<HTMLElement>(".emergency-card")).forEach((card) => {
      card.style.display = "none";
    });
    if (!existingEmptyMsg) {
      const p = document.createElement("p");
      p.className = "empty-state-msg";
      p.textContent = "No emergencies match this filter.";
      grid.appendChild(p);
    }
    updateNotifications();
    return;
  }

  existingEmptyMsg?.remove();

  const visibleIds = new Set(filtered.map((e) => e.id));
  Array.from(grid.querySelectorAll<HTMLElement>(".emergency-card")).forEach((card) => {
    card.style.display = visibleIds.has(card.dataset.id || "") ? "" : "none";
  });

  filtered.forEach((e) => {
    const existingCard = grid.querySelector<HTMLElement>(`[data-id="${CSS.escape(e.id)}"]`);
    if (existingCard) {
      existingCard.style.display = "";
      syncCardDynamicState(existingCard, e);
      grid.appendChild(existingCard);
    } else {
      grid.appendChild(createEmergencyCardDOM(e));
    }
  });

  updateNotifications();
}

// ============ LIVE FEED NOTIFICATIONS ============
function updateNotifications(): void {
  const panel = document.getElementById("notifications");
  if (!panel) return;
  panel.replaceChildren();

  if (emergencies.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.style.cssText = "color:#64748b;font-size:13px";
    emptyP.textContent = t("noRecentIncidents");
    panel.appendChild(emptyP);
    return;
  }

  const recent = [...emergencies].sort((a, b) => b.createdAtMs - a.createdAtMs);
  recent.slice(0, 5).forEach((e) => {
    const tc = TYPE_COLORS[e.type] || TYPE_COLORS.Minor;
    const div = document.createElement("div");
    div.className = `notification notif-${e.type.toLowerCase()} notif-default`;

    const wrap = document.createElement("div");
    const titleLine = document.createElement("div");
    const strongType = document.createElement("strong");
    strongType.textContent = e.type;
    titleLine.append(
      document.createTextNode(`${tc.emoji} `),
      strongType,
      document.createTextNode(` at ${e.location}`)
    );

    const timeLine = document.createElement("div");
    timeLine.className = "notif-time";
    timeLine.textContent = `${e.priority} Priority · ${formatRelativeTime(e.createdAtMs)}`;

    wrap.append(titleLine, timeLine);
    div.appendChild(wrap);
    panel.appendChild(div);
  });
}

// ============ UNITS & FLEET PANEL ============
function renderUnitsList(): void {
  const container = document.getElementById("unitsGrid");
  if (!container) return;
  container.replaceChildren();

  if (responseUnits.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state-msg";
    p.textContent = "No response units registered yet.";
    container.appendChild(p);
    return;
  }

  responseUnits.forEach((u) => {
    const item = document.createElement("div");
    item.className = "unit-card";

    const nameStrong = document.createElement("strong");
    nameStrong.textContent = `🚓 ${u.name} (${u.type})`;

    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${u.status === "available" ? "low" : "medium"}`;
    statusBadge.textContent = u.status.toUpperCase();

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:12px;color:#94a3b8;margin-top:4px";
    meta.textContent = `Crew: ${u.capacity} · Contact: ${u.contactPhone}`;

    item.append(nameStrong, statusBadge, meta);
    container.appendChild(item);
  });
}

async function handleCreateUnit(e: Event): Promise<void> {
  e.preventDefault();
  const name = (document.getElementById("unitName") as HTMLInputElement)?.value.trim() || "";
  const type = ((document.getElementById("unitType") as HTMLSelectElement)?.value ||
    "Fire") as UnitType;
  const capacity = Number(
    (document.getElementById("unitCapacity") as HTMLInputElement)?.value || 4
  );
  const contactPhone =
    (document.getElementById("unitPhone") as HTMLInputElement)?.value.trim() || "112";
  if (!name) {
    showToast("Enter a unit callsign (e.g., Engine-01).", "warning");
    return;
  }
  const cr = getControlRoomCoords();
  try {
    await createResponseUnit({
      name,
      type,
      lat: cr.lat + (Math.random() - 0.5) * 0.04,
      lng: cr.lng + (Math.random() - 0.5) * 0.04,
      capacity,
      contactPhone,
    });
    (document.getElementById("unitName") as HTMLInputElement).value = "";
    showToast(`Unit ${name} added to active fleet.`, "success");
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), "error");
  }
}

// ============ INCIDENT TIMELINE MODAL ============
async function openTimelineModal(incident: IncidentRecord): Promise<void> {
  const dialog = document.getElementById("timelineDialog") as HTMLDialogElement | null;
  const listEl = document.getElementById("timelineList");
  const titleEl = document.getElementById("timelineDialogTitle");
  if (!dialog || !listEl || !titleEl) return;

  titleEl.textContent = `Incident Timeline — ${incident.type} (${incident.location})`;
  listEl.replaceChildren();

  const loadingP = document.createElement("p");
  loadingP.textContent = "Loading audit timeline...";
  listEl.appendChild(loadingP);
  dialog.showModal();

  try {
    const events = await fetchIncidentTimeline(incident.id);
    listEl.replaceChildren();
    if (events.length === 0) {
      const p = document.createElement("p");
      p.textContent = `Reported at ${formatDateTime(incident.createdAtMs)} (Status: ${incident.status})`;
      listEl.appendChild(p);
      return;
    }
    events.forEach((ev) => {
      const row = document.createElement("div");
      row.className = "timeline-row";
      const timeSpan = document.createElement("div");
      timeSpan.className = "notif-time";
      timeSpan.textContent = `${formatDateTime(ev.createdAtMs)} · Role: ${ev.actorRole.toUpperCase()}`;
      const noteDiv = document.createElement("div");
      noteDiv.textContent = ev.note;
      row.append(timeSpan, noteDiv);
      listEl.appendChild(row);
    });
  } catch (err) {
    listEl.replaceChildren();
    const errP = document.createElement("p");
    errP.textContent = `Could not load timeline: ${err instanceof Error ? err.message : String(err)}`;
    listEl.appendChild(errP);
  }
}

// ============ ADMIN USER & ROLE MANAGEMENT ============
async function loadAdminUsersTable(): Promise<void> {
  const tbody = document.getElementById("adminUsersBody");
  if (!tbody || currentUserRole !== "admin") return;
  tbody.replaceChildren();

  try {
    const users = await fetchAllUsersForAdmin();
    users.forEach((u) => {
      const tr = document.createElement("tr");
      const tdEmail = document.createElement("td");
      tdEmail.textContent = u.email || u.uid;

      const tdRole = document.createElement("td");
      const roleSelect = document.createElement("select");
      (["citizen", "responder", "dispatcher", "admin"] as UserRole[]).forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r.toUpperCase();
        opt.selected = u.role === r;
        roleSelect.appendChild(opt);
      });

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "lang-btn";
      saveBtn.style.marginLeft = "8px";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async () => {
        if (!currentUser) return;
        try {
          await updateUserRoleAsAdmin(u.uid, roleSelect.value as UserRole, currentUser.uid);
          showToast(`Updated ${u.email || u.uid} role to ${roleSelect.value}.`, "success");
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err), "error");
        }
      });

      tdRole.append(roleSelect, saveBtn);
      tr.append(tdEmail, tdRole);
      tbody.appendChild(tr);
    });
  } catch {
    // Non-fatal if empty
  }
}

// ============ I18N & REDUCED MOTION ============
function applyTranslations(): void {
  const setTxt = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setTxt("title", t("appTitle"));
  setTxt("brandSubtitle", t("appSubtitle"));
  setTxt("authTitle", signupMode ? t("signupTitle") : t("loginTitle"));
  setTxt("authSubmitText", signupMode ? t("signupBtn") : t("loginBtn"));
  setTxt("switchText", signupMode ? t("haveAccount") : t("noAccount"));
  setTxt("toggleAuthBtn", signupMode ? t("loginBtn") : t("signupBtn"));
  setTxt("resetPasswordBtn", t("resetPassBtn"));
  setTxt("logoutBtn", t("logoutBtn"));
  setTxt("emergencyBannerText", t("emergencyCallBanner"));
  setTxt("reportTitleText", t("reportTitle"));
  setTxt("typeGroupLabel", t("typeLabel"));
  setTxt("notifTitleText", t("liveFeedTitle"));
  setTxt("dashboardTitle", `⚡ ${t("dashboardTitle")}`);
  setTxt("exportCsvBtn", `📥 ${t("exportCsvBtn")}`);
  setTxt("loadMoreBtn", t("loadMoreBtn"));
  setTxt("privacyBtn", `🔒 ${t("privacyBtn")}`);
}

function toggleLanguage(): void {
  const next = getLocale() === "en" ? "hi" : "en";
  setLocale(next);
  applyTranslations();
  smartRender();
}

function toggleReducedMotion(): void {
  document.body.classList.toggle("reduced-motion");
  const isReduced = document.body.classList.contains("reduced-motion");
  showToast(
    isReduced
      ? "Reduced motion enabled (scanlines and pulse animations disabled)."
      : "Standard animations enabled.",
    "info"
  );
}

// ============ BOOTSTRAP & EVENT WIRING ============
function initApp(): void {
  initObservability();
  applyTranslations();

  document.getElementById("authForm")?.addEventListener("submit", (e) => void handleAuthSubmit(e));
  document.getElementById("toggleAuthBtn")?.addEventListener("click", toggleAuth);
  document
    .getElementById("resetPasswordBtn")
    ?.addEventListener("click", () => void handlePasswordReset());

  document.getElementById("langToggleBtn")?.addEventListener("click", toggleLanguage);
  document.getElementById("reducedMotionBtn")?.addEventListener("click", toggleReducedMotion);
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    void signOutUser().then(() => showToast("Signed out.", "info"));
  });

  document.querySelectorAll<HTMLElement>(".type-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".type-pill").forEach((p) => {
        p.classList.remove("active");
        p.setAttribute("aria-checked", "false");
      });
      pill.classList.add("active");
      pill.setAttribute("aria-checked", "true");
      const input = document.getElementById("type") as HTMLInputElement | null;
      if (input && pill.dataset.val) input.value = pill.dataset.val;
    });
  });

  const locInput = document.getElementById("location");
  locInput?.addEventListener("input", handleLocationInput);
  locInput?.addEventListener("keydown", (e: KeyboardEvent) => {
    const dd = document.getElementById("locationDropdown");
    if (!dd || dd.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      ddActiveIdx = Math.min(ddActiveIdx + 1, ddItems.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      ddActiveIdx = Math.max(ddActiveIdx - 1, 0);
    } else if (e.key === "Enter" && ddActiveIdx >= 0) {
      e.preventDefault();
      selectLocation(ddActiveIdx);
      return;
    } else if (e.key === "Escape") {
      closeDropdown();
      return;
    }
    document.querySelectorAll(".dd-item").forEach((el, i) => {
      el.classList.toggle("active", i === ddActiveIdx);
    });
  });

  document.getElementById("geoLocateBtn")?.addEventListener("click", handleUseMyLocation);
  document.getElementById("showMapBtn")?.addEventListener("click", () => {
    const val = (document.getElementById("location") as HTMLInputElement)?.value.trim() || "";
    if (!val) {
      showToast("Enter a location or click Use My Location.", "warning");
      return;
    }
    void searchLocations(val, getLocale()).then((res) => {
      if (!res.length) {
        showToast("Location not found.", "warning");
        return;
      }
      selectedCoords = { lat: res[0].lat, lng: res[0].lng };
      updateComputedDistanceDisplay(selectedCoords);
      renderLocationPickerMap(selectedCoords, res[0].displayName, (moved) => {
        selectedCoords = moved;
        updateComputedDistanceDisplay(moved);
      });
    });
  });

  const fileDrop = document.getElementById("fileDrop");
  const fileInput = document.getElementById("image") as HTMLInputElement | null;
  const previewImage = () => {
    const file = fileInput?.files?.[0];
    const preview = document.getElementById("imagePreview") as HTMLImageElement | null;
    const label = document.getElementById("fileLabel");
    if (file && preview && label) {
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
      label.textContent = file.name;
    }
  };
  fileDrop?.addEventListener("click", () => fileInput?.click());
  fileDrop?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput?.click();
    }
  });
  fileDrop?.addEventListener("dragover", (e) => e.preventDefault());
  fileDrop?.addEventListener("drop", (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && validateImageFile(file).valid && fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      previewImage();
    } else {
      showToast("Please drop a valid JPEG, PNG, or WebP image (max 5MB).", "warning");
    }
  });
  fileInput?.addEventListener("change", previewImage);

  document
    .getElementById("reportForm")
    ?.addEventListener("submit", (e) => void handleReportSubmit(e));

  document.querySelectorAll<HTMLElement>(".filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      dashFilter = btn.dataset.filter || "all";
      document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      smartRender();
    });
  });

  document.getElementById("searchInput")?.addEventListener("input", (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    smartRender();
  });

  document.getElementById("sortSelect")?.addEventListener("change", (e) => {
    sortBy = (e.target as HTMLSelectElement).value as "priority" | "newest" | "distance";
    smartRender();
  });

  document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
    const csv = exportIncidentsToCsv(getFilteredAndSortedIncidents());
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cers-incidents-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("loadMoreBtn")?.addEventListener("click", () => {
    pageSize += 25;
    startRealtimeSubscriptions();
    showToast(`Loading up to ${pageSize} incidents...`, "info");
  });

  document
    .getElementById("createUnitForm")
    ?.addEventListener("submit", (e) => void handleCreateUnit(e));

  document.getElementById("closeTimelineBtn")?.addEventListener("click", () => {
    (document.getElementById("timelineDialog") as HTMLDialogElement | null)?.close();
  });

  document.getElementById("privacyBtn")?.addEventListener("click", () => {
    (document.getElementById("privacyDialog") as HTMLDialogElement | null)?.showModal();
  });
  document.getElementById("closePrivacyBtn")?.addEventListener("click", () => {
    (document.getElementById("privacyDialog") as HTMLDialogElement | null)?.close();
  });
  document.getElementById("deleteAccountBtn")?.addEventListener("click", async () => {
    if (!currentUser) return;
    const confirmed = await showConfirmModal(
      "Delete Account & Personal Data",
      "This will permanently delete your CERS profile and cancel any unassigned reports. Continue?"
    );
    if (!confirmed) return;
    try {
      await deleteMyAccountAndData(currentUser);
      showToast("Your account and personal profile data have been deleted.", "info");
    } catch (err) {
      showToast(`Account deletion error: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });

  window.addEventListener("online", () => {
    showToast("Back online! Syncing queued reports...", "success");
    void syncOfflineQueuedReports();
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (target && !target.closest(".location-wrapper")) closeDropdown();
  });

  // Register PWA Service Worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Ignore service worker registration errors in dev mode
      });
    });
  }
}

initApp();
