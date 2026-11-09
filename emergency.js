import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  deleteUser,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  serverTimestamp,
  GeoPoint,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCsQyW9xmh1lXSYY8oPmFGAETUquWJI8JY",
  authDomain: "city-emergency-dispatcher.firebaseapp.com",
  projectId: "city-emergency-dispatcher",
  storageBucket: "city-emergency-dispatcher.firebasestorage.app",
  messagingSenderId: "364720673291",
  appId: "1:364720673291:web:7a37303cce58f8bcdbad0e",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const CONTROL_ROOM_COORDS = { lat: 28.6139, lng: 77.209 };
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const OFFLINE_QUEUE_KEY = "cers_offline_report_queue_v1";
const LOCALE_STORAGE_KEY = "cers_locale";

// ============ I18N DICTIONARIES ============
const I18N = {
  en: {
    appTitle: "City Emergency Response",
    appSubtitle: "Live Operations & Dispatch Command",
    loginTitle: "Login",
    signupTitle: "Create Account",
    loginBtn: "Login",
    signupBtn: "Create Account",
    resetPassBtn: "Forgot Password?",
    noAccount: "No account?",
    haveAccount: "Have an account?",
    logoutBtn: "Logout",
    emergencyCallBanner: "LIFE-THREATENING EMERGENCY? CALL OFFICIAL HELPLINES IMMEDIATELY:",
    reportTitle: "Report Emergency",
    typeLabel: "Emergency Type",
    fileDropPrompt: "Click or drag & drop image here",
    submitReportBtn: "Submit Emergency Report",
    submittingBtn: "Submitting...",
    liveFeedTitle: "Live Feed",
    noRecentIncidents: "No recent emergencies.",
    dashboardTitle: "Emergency Dashboard",
    privacyBtn: "Privacy & My Data",
    exportCsvBtn: "Export CSV",
    loadMoreBtn: "Load More Incidents",
  },
  hi: {
    appTitle: "शहर आपातकालीन प्रणाली",
    appSubtitle: "लाइव संचालन और डिस्पैच नियंत्रण कक्ष",
    loginTitle: "लॉगिन करें",
    signupTitle: "नया खाता बनाएँ",
    loginBtn: "लॉगिन",
    signupBtn: "खाता बनाएँ",
    resetPassBtn: "पासवर्ड भूल गए?",
    noAccount: "खाता नहीं है?",
    haveAccount: "पहले से खाता है?",
    logoutBtn: "लॉगआउट",
    emergencyCallBanner: "जानलेवा आपातकाल? तुरंत आधिकारिक हेल्पलाइन पर कॉल करें:",
    reportTitle: "आपातकाल रिपोर्ट करें",
    typeLabel: "आपातकाल का प्रकार",
    fileDropPrompt: "फ़ोटो चुनने के लिए क्लिक करें या यहाँ खींचें",
    submitReportBtn: "आपातकालीन रिपोर्ट भेजें",
    submittingBtn: "भेजा जा रहा है...",
    liveFeedTitle: "नवीनतम घटनाएँ",
    noRecentIncidents: "कोई हालिया आपातकालीन घटना नहीं है।",
    dashboardTitle: "आपातकाल डैशबोर्ड",
    privacyBtn: "गोपनीयता और मेरा डेटा",
    exportCsvBtn: "CSV डाउनलोड करें",
    loadMoreBtn: "अधिक घटनाएँ देखें",
  },
};

// ============ STATE ============
let emergencies = [];
let responseUnits = [];
let currentUser = null;
let selectedLoginPortal = "citizen"; // 'citizen' | 'authority'
let currentUserRole = "citizen";
let signupMode = false;
let lang = localStorage.getItem(LOCALE_STORAGE_KEY) === "hi" ? "hi" : "en";
let selectedCoords = null;
let pickerMap = null;
let pickerMarker = null;
let operationsMap = null;
let operationsLayerGroup = null;
let unsubscribeEmergencies = null;
let unsubscribeUnits = null;
let ddItems = [];
let ddActiveIdx = -1;
let ddDebounce = null;
let dashFilter = "all";
let searchQuery = "";
let sortBy = "priority";
let pageSize = 25;
const submissionTimestamps = [];
const previousStatusMap = new Map();

const TYPE_COLORS = {
  Fire: { hex: "#ff4500", emoji: "🔥", class: "banner-fire" },
  Medical: { hex: "#00e676", emoji: "🏥", class: "banner-medical" },
  Accident: { hex: "#ff9800", emoji: "🚗", class: "banner-accident" },
  Police: { hex: "#2979ff", emoji: "🚔", class: "banner-police" },
  Minor: { hex: "#ab47bc", emoji: "⚠️", class: "banner-minor" },
};

const VALID_STATE_TRANSITIONS = {
  reported: ["verified", "assigned", "false_alarm", "cancelled"],
  Pending: ["verified", "assigned", "resolved", "Resolved", "false_alarm", "cancelled"],
  verified: ["assigned", "false_alarm", "cancelled"],
  assigned: ["en_route", "on_scene", "resolved", "cancelled"],
  en_route: ["on_scene", "resolved"],
  on_scene: ["resolved"],
  resolved: ["closed"],
  Resolved: ["closed"],
  closed: [],
  false_alarm: [],
  cancelled: [],
};

function t(key) {
  return I18N[lang]?.[key] || I18N.en[key] || key;
}

// ============ GEOSPATIAL & TRIAGE ENGINE ============
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
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
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

function calculatePriorityScore(input) {
  const baseScores = { Fire: 40, Medical: 38, Accident: 32, Police: 28, Minor: 12 };
  const baseWeights = { Fire: 1, Medical: 2, Accident: 3, Police: 4, Minor: 5 };
  const sevScores = { critical: 30, high: 22, moderate: 12, low: 4 };
  const vulnScores = { trapped: 12, hazmat: 10, children: 6, elderly: 6 };

  const base = baseScores[input.type] ?? 15;
  const sev = sevScores[input.reportedSeverity] ?? 12;
  const peopleBonus = Math.min(15, Math.max(0, (Number(input.peopleAffected || 1) - 1) * 3));
  let vulnBonus = 0;
  for (const f of input.vulnerabilityFlags || []) vulnBonus += vulnScores[f] ?? 0;
  vulnBonus = Math.min(20, vulnBonus);
  const distFactor = input.distanceKm < 5 ? 5 : input.distanceKm <= 10 ? 3 : 1;

  const score = Math.min(100, base + sev + peopleBonus + vulnBonus + distFactor);
  const level =
    score >= 75 ? "Critical" : score >= 55 ? "High" : score >= 35 ? "Medium" : "Low";
  let weight = baseWeights[input.type] ?? 5;
  if (level === "Critical") weight = 1;
  else if (level === "High" && weight > 2) weight -= 1;

  return { score, level, weight };
}

function canTransitionState(from, to, role, isReporter = false) {
  const allowedNext = VALID_STATE_TRANSITIONS[from] || [];
  if (!allowedNext.includes(to)) return false;
  if (role === "admin" || role === "dispatcher") return true;
  if (role === "responder") {
    return (
      (from === "assigned" && to === "en_route") ||
      (from === "en_route" && to === "on_scene") ||
      (from === "on_scene" && to === "resolved") ||
      (from === "Pending" && to === "Resolved")
    );
  }
  if (role === "citizen" && isReporter) {
    return (from === "reported" || from === "Pending") && to === "cancelled";
  }
  return false;
}

// ============ ACCESSIBLE TOAST & MODAL ============
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const msgSpan = document.createElement("span");
  msgSpan.textContent = String(message);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Dismiss notification");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => toast.remove());
  toast.append(msgSpan, closeBtn);
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.isConnected) toast.remove();
  }, 4500);
}

function showConfirmModal(title, description) {
  return new Promise((resolvePromise) => {
    const dialog = document.getElementById("confirmDialog");
    const titleEl = document.getElementById("confirmDialogTitle");
    const descEl = document.getElementById("confirmDialogDesc");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    if (!dialog || typeof dialog.showModal !== "function") {
      resolvePromise(false);
      return;
    }
    titleEl.textContent = title;
    descEl.textContent = description;
    const cleanup = (result) => {
      okBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolvePromise(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    cancelBtn.focus();
  });
}

function isValidImageSrc(src) {
  if (typeof src !== "string" || !src) return false;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return true;
  try {
    const parsed = new URL(src);
    return parsed.protocol === "https:" && parsed.hostname === "firebasestorage.googleapis.com";
  } catch {
    return false;
  }
}

// ============ AUTH & RBAC ============
async function resolveUserRole(user) {
  const chosenPortalRole =
    selectedLoginPortal === "authority"
      ? document.getElementById("authorityRoleSelect")?.value || "dispatcher"
      : "citizen";

  try {
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    if (snap.exists() && snap.data().role) {
      // If user explicitly logged in via Authority tab, allow previewing the selected authority role
      if (selectedLoginPortal === "authority") {
        return chosenPortalRole;
      }
      return String(snap.data().role);
    }
    await setDoc(
      userRef,
      {
        uid: user.uid,
        email: user.email || "",
        role: chosenPortalRole,
        preferredLang: lang,
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch {
    // Fallback to chosen portal role
  }
  return chosenPortalRole;
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    currentUserRole = await resolveUserRole(user);
    const roleSwitcher = document.getElementById("roleSwitcher");
    if (roleSwitcher) roleSwitcher.value = currentUserRole;
    document.getElementById("authPage")?.classList.add("hidden");
    document.getElementById("app")?.classList.remove("hidden");
    updateRoleVisibility();
    applyTranslations();
    startRealtimeSubscriptions();
  } else {
    currentUser = null;
    if (unsubscribeEmergencies) {
      unsubscribeEmergencies();
      unsubscribeEmergencies = null;
    }
    if (unsubscribeUnits) {
      unsubscribeUnits();
      unsubscribeUnits = null;
    }
    emergencies = [];
    document.getElementById("authPage")?.classList.remove("hidden");
    document.getElementById("app")?.classList.add("hidden");
  }
});

function updateRoleVisibility() {
  const isCitizen = currentUserRole === "citizen";
  const isResponder = currentUserRole === "responder";
  const isDispatcher = currentUserRole === "dispatcher";
  const isAdmin = currentUserRole === "admin";
  const isStaff = isResponder || isDispatcher || isAdmin;
  const isDispatcherOrAdmin = isDispatcher || isAdmin;

  // Toggle main portal views based on active role
  document.getElementById("citizenPortalView")?.classList.toggle("hidden", !isCitizen);
  document.getElementById("responderPortalView")?.classList.toggle("hidden", !isResponder);
  document.getElementById("dispatcherPortalView")?.classList.toggle("hidden", !isDispatcherOrAdmin);

  // Toggle sub-features inside dispatcher portal
  document.getElementById("createUnitForm")?.classList.toggle("hidden", !isDispatcherOrAdmin);
  document.getElementById("adminUsersSection")?.classList.toggle("hidden", !isAdmin);

  if (isCitizen) {
    renderCitizenTrackingList();
  } else if (isResponder) {
    renderResponderMdtView();
  } else if (isDispatcherOrAdmin) {
    setTimeout(() => renderOperationsClusterMap(), 150);
    renderAnalyticsPanel();
    smartRender();
    if (isAdmin) {
      void loadAdminUsersTable();
    }
  }
}

// ============ CITIZEN LIVE INCIDENT TRACKER ============
function renderCitizenTrackingList() {
  const container = document.getElementById("citizenTrackingList");
  if (!container) return;
  container.replaceChildren();

  const myIncidents = emergencies.filter(
    (e) => !currentUser || e.reporterUid === currentUser.uid || e.uid === currentUser.uid
  );

  if (myIncidents.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state-msg";
    p.textContent = "You have not submitted any emergency reports yet. Use the form to report an incident.";
    container.appendChild(p);
    return;
  }

  const STAGES = [
    { key: "reported", label: "Reported", icon: "⏱️" },
    { key: "verified", label: "Verified", icon: "📋" },
    { key: "assigned", label: "Dispatched", icon: "🚓" },
    { key: "en_route", label: "En Route", icon: "🚨" },
    { key: "on_scene", label: "On Scene", icon: "📍" },
    { key: "resolved", label: "Resolved", icon: "✅" },
  ];

  function getActiveStageIndex(status) {
    switch (status) {
      case "reported":
      case "Pending":
        return 0;
      case "verified":
        return 1;
      case "assigned":
        return 2;
      case "en_route":
        return 3;
      case "on_scene":
        return 4;
      case "resolved":
      case "Resolved":
      case "closed":
        return 5;
      default:
        return 0;
    }
  }

  myIncidents.forEach((inc) => {
    const card = document.createElement("article");
    card.className = "tracking-card";

    const tc = TYPE_COLORS[inc.type] || TYPE_COLORS.Minor;
    const isResolved = ["resolved", "Resolved", "closed"].includes(inc.status);
    const isCancelled = inc.status === "cancelled" || inc.status === "false_alarm";

    const topHeader = document.createElement("div");
    topHeader.className = "tracking-card-header";

    const titleWrap = document.createElement("div");
    const titleStrong = document.createElement("strong");
    titleStrong.style.fontSize = "1.05rem";
    titleStrong.textContent = `${tc.emoji} ${inc.type} Report · ${inc.location}`;
    const timeSub = document.createElement("div");
    timeSub.className = "notif-time";
    timeSub.textContent = `Reported: ${formatRelativeTime(inc.createdAtMs)} · Distance: ${inc.distance} km`;
    titleWrap.append(titleStrong, timeSub);

    const badge = document.createElement("span");
    badge.className = `badge ${isResolved ? "low" : "high"}`;
    badge.textContent = inc.status.toUpperCase();
    topHeader.append(titleWrap, badge);

    card.appendChild(topHeader);

    // Render 6-stage milestone stepper (unless cancelled)
    if (!isCancelled) {
      const activeIdx = getActiveStageIndex(inc.status);
      const stepper = document.createElement("div");
      stepper.className = "status-stepper";

      STAGES.forEach((st, idx) => {
        const node = document.createElement("div");
        const isCompleted = idx <= activeIdx;
        const isCurrent = idx === activeIdx;
        node.className = `step-node ${isCompleted ? "completed" : ""} ${isCurrent ? "active" : ""}`;

        const dot = document.createElement("div");
        dot.className = "step-dot";
        dot.textContent = isCompleted ? "✓" : String(idx + 1);

        const lbl = document.createElement("div");
        lbl.textContent = `${st.icon} ${st.label}`;

        node.append(dot, lbl);
        stepper.appendChild(node);

        if (idx < STAGES.length - 1) {
          const connector = document.createElement("div");
          connector.className = `step-connector ${idx < activeIdx ? "completed" : ""}`;
          stepper.appendChild(connector);
        }
      });
      card.appendChild(stepper);
    } else {
      const cancelMsg = document.createElement("p");
      cancelMsg.style.cssText = "color:#f87171;font-size:13px;margin:8px 0";
      cancelMsg.textContent = `This report was ${inc.status === "cancelled" ? "cancelled by you" : "flagged as a false alarm"}.`;
      card.appendChild(cancelMsg);
    }

    // Details summary
    const descP = document.createElement("p");
    descP.className = "ec-desc";
    descP.style.marginTop = "10px";
    descP.textContent = `Description: ${inc.desc}`;
    card.appendChild(descP);

    // Cancel action if still unassigned
    if ((inc.status === "reported" || inc.status === "Pending") && currentUser) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "deleteBtn";
      cancelBtn.style.cssText = "width:auto;padding:6px 14px;margin-top:8px";
      cancelBtn.textContent = "Cancel This Report";
      cancelBtn.addEventListener("click", async () => {
        const ok = await showConfirmModal("Cancel Report", "Are you sure you want to cancel this emergency request?");
        if (!ok) return;
        try {
          await updateDoc(doc(db, "emergencies", inc.id), {
            status: "cancelled",
            updatedAt: serverTimestamp(),
          });
          showToast("Emergency report cancelled.", "info");
        } catch (err) {
          showToast(err.message, "error");
        }
      });
      card.appendChild(cancelBtn);
    }

    // Rating & Feedback if resolved
    if (isResolved) {
      card.appendChild(buildFeedbackSection(inc));
    }

    container.appendChild(card);
  });
}

// ============ RESPONDER VEHICLE TERMINAL (MDT) ============
function renderResponderMdtView() {
  const detailsContainer = document.getElementById("responderIncidentDetails");
  if (!detailsContainer) return;
  detailsContainer.replaceChildren();

  // Find any active call assigned to response units
  const activeAssigned = emergencies.find(
    (e) =>
      !["resolved", "Resolved", "closed", "cancelled", "false_alarm"].includes(e.status) &&
      e.assignedUnitIds &&
      e.assignedUnitIds.length > 0
  ) || emergencies.find((e) => !["resolved", "Resolved", "closed"].includes(e.status));

  if (!activeAssigned) {
    const p = document.createElement("p");
    p.style.cssText = "color:var(--muted);font-size:14px;padding:12px 0";
    p.textContent = "No emergency calls currently assigned to your unit. Vehicle telemetry is active on standby.";
    detailsContainer.appendChild(p);
    return;
  }

  const tc = TYPE_COLORS[activeAssigned.type] || TYPE_COLORS.Minor;

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:12px";
  const title = document.createElement("h3");
  title.style.cssText = "font-family:var(--font-head);font-size:1.3rem;color:white";
  title.textContent = `${tc.emoji} ${activeAssigned.type} EMERGENCY — ${activeAssigned.location}`;
  const badge = document.createElement("span");
  badge.className = "badge high";
  badge.textContent = `STATUS: ${activeAssigned.status.toUpperCase()}`;
  header.append(title, badge);

  const infoRow = document.createElement("div");
  infoRow.style.cssText = "font-size:14px;line-height:1.6;margin-bottom:14px";

  const locDiv = document.createElement("div");
  locDiv.innerHTML = "📍 <strong>Location:</strong> ";
  const locSpan = document.createElement("span");
  locSpan.textContent = `${activeAssigned.location} (${activeAssigned.distance} km from control base)`;
  locDiv.appendChild(locSpan);

  const sevDiv = document.createElement("div");
  sevDiv.innerHTML = "⚠️ <strong>Severity:</strong> ";
  const sevSpan = document.createElement("span");
  sevSpan.textContent = `${activeAssigned.reportedSeverity.toUpperCase()} · 👥 People Impacted: ${activeAssigned.peopleAffected}`;
  sevDiv.appendChild(sevSpan);

  const hazDiv = document.createElement("div");
  hazDiv.innerHTML = "🛡️ <strong>Hazards / Vulnerabilities:</strong> ";
  const hazSpan = document.createElement("span");
  hazSpan.textContent =
    activeAssigned.vulnerabilityFlags && activeAssigned.vulnerabilityFlags.length > 0
      ? activeAssigned.vulnerabilityFlags.join(", ").toUpperCase()
      : "None reported";
  hazDiv.appendChild(hazSpan);

  const descDiv = document.createElement("div");
  descDiv.innerHTML = "📝 <strong>Situation Report:</strong> ";
  const descSpan = document.createElement("span");
  descSpan.textContent = activeAssigned.desc;
  descDiv.appendChild(descSpan);

  infoRow.append(locDiv, sevDiv, hazDiv, descDiv);

  // Tactical one-tap milestone buttons
  const actionsGrid = document.createElement("div");
  actionsGrid.className = "mdt-tactical-buttons";

  const btnEnRoute = document.createElement("button");
  btnEnRoute.type = "button";
  btnEnRoute.className = "mdt-btn mdt-btn-enroute";
  btnEnRoute.textContent = "🚨 1. ACCEPT & EN ROUTE";
  btnEnRoute.addEventListener("click", async () => {
    try {
      if (currentUser?.uid?.startsWith("demo-")) {
        activeAssigned.status = "en_route";
        renderResponderMdtView();
        showToast("Unit marked EN ROUTE to scene.", "success");
        return;
      }
      await updateDoc(doc(db, "emergencies", activeAssigned.id), {
        status: "en_route",
        updatedAt: serverTimestamp(),
      });
      await addDoc(collection(db, "emergencies", activeAssigned.id, "timeline"), {
        incidentId: activeAssigned.id,
        actorUid: currentUser?.uid || "responder",
        actorRole: "responder",
        action: "status_change",
        fromState: activeAssigned.status,
        toState: "en_route",
        note: "Unit acknowledged call and is en route to coordinates with sirens",
        createdAt: serverTimestamp(),
      });
      showToast("Unit marked EN ROUTE to scene.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  const btnOnScene = document.createElement("button");
  btnOnScene.type = "button";
  btnOnScene.className = "mdt-btn mdt-btn-onscene";
  btnOnScene.textContent = "📍 2. ARRIVED ON SCENE";
  btnOnScene.addEventListener("click", async () => {
    try {
      if (currentUser?.uid?.startsWith("demo-")) {
        activeAssigned.status = "on_scene";
        renderResponderMdtView();
        showToast("Unit marked ON SCENE. Dispatcher notified.", "success");
        return;
      }
      await updateDoc(doc(db, "emergencies", activeAssigned.id), {
        status: "on_scene",
        updatedAt: serverTimestamp(),
      });
      await addDoc(collection(db, "emergencies", activeAssigned.id, "timeline"), {
        incidentId: activeAssigned.id,
        actorUid: currentUser?.uid || "responder",
        actorRole: "responder",
        action: "status_change",
        fromState: activeAssigned.status,
        toState: "on_scene",
        note: "Unit arrived at coordinates and commenced emergency operations",
        createdAt: serverTimestamp(),
      });
      showToast("Unit marked ON SCENE. Dispatcher notified.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  const btnResolve = document.createElement("button");
  btnResolve.type = "button";
  btnResolve.className = "mdt-btn mdt-btn-resolve";
  btnResolve.textContent = "✔️ 3. RESOLVE & CLEAR";
  btnResolve.addEventListener("click", async () => {
    try {
      if (currentUser?.uid?.startsWith("demo-")) {
        activeAssigned.status = "resolved";
        activeAssigned.resolvedAtMs = Date.now();
        renderResponderMdtView();
        showToast("Call marked RESOLVED. Unit available for next call.", "success");
        return;
      }
      await updateDoc(doc(db, "emergencies", activeAssigned.id), {
        status: "resolved",
        resolvedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await addDoc(collection(db, "emergencies", activeAssigned.id, "timeline"), {
        incidentId: activeAssigned.id,
        actorUid: currentUser?.uid || "responder",
        actorRole: "responder",
        action: "status_change",
        fromState: activeAssigned.status,
        toState: "resolved",
        note: "Incident mitigated and cleared. Unit returning to available status.",
        createdAt: serverTimestamp(),
      });
      showToast("Call marked RESOLVED. Unit available for next call.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  actionsGrid.append(btnEnRoute, btnOnScene, btnResolve);
  detailsContainer.append(header, infoRow, actionsGrid);
}

// ============ REALTIME FIRESTORE SUBSCRIPTIONS ============
function getIncidentTimestampMs(inc) {
  if (inc.createdAt && typeof inc.createdAt.toMillis === "function") {
    return inc.createdAt.toMillis();
  }
  if (typeof inc.timestamp === "number") return inc.timestamp;
  return Date.now();
}

function normalizeIncident(id, data) {
  let coords = null;
  if (data.coordinates) {
    if (typeof data.coordinates.latitude === "number") {
      coords = { lat: data.coordinates.latitude, lng: data.coordinates.longitude };
    } else if (typeof data.coordinates.lat === "number") {
      coords = { lat: Number(data.coordinates.lat), lng: Number(data.coordinates.lng) };
    }
  }
  return {
    id,
    uid: data.uid || data.reporterUid || "",
    reporterUid: data.reporterUid || data.uid || "",
    type: data.type || "Fire",
    reportedSeverity: data.reportedSeverity || "high",
    peopleAffected: Number(data.peopleAffected || 1),
    vulnerabilityFlags: Array.isArray(data.vulnerabilityFlags) ? data.vulnerabilityFlags : [],
    location: data.location || "",
    desc: data.desc || "",
    coordinates: coords,
    geohash: data.geohash || (coords ? encodeGeohash(coords.lat, coords.lng) : ""),
    distance: Number(data.distance ?? 0),
    priorityScore: Number(data.priorityScore ?? 65),
    priority: data.priority || "High",
    weight: Number(data.weight ?? 3),
    status: data.status || "reported",
    assignedUnitIds: Array.isArray(data.assignedUnitIds) ? data.assignedUnitIds : [],
    assignedResponderUids: Array.isArray(data.assignedResponderUids)
      ? data.assignedResponderUids
      : [],
    mergedIntoId: data.mergedIntoId || null,
    duplicateCount: Number(data.duplicateCount || 0),
    img: data.img || "",
    rating: typeof data.rating === "number" ? data.rating : null,
    feedback: data.feedback || "",
    abuseFlags: Number(data.abuseFlags || 0),
    archived: Boolean(data.archived),
    createdAtMs: getIncidentTimestampMs(data),
    resolvedAtMs:
      data.resolvedAt && typeof data.resolvedAt.toMillis === "function"
        ? data.resolvedAt.toMillis()
        : null,
  };
}

function startRealtimeSubscriptions() {
  if (unsubscribeEmergencies) {
    unsubscribeEmergencies();
    unsubscribeEmergencies = null;
  }
  if (unsubscribeUnits) {
    unsubscribeUnits();
    unsubscribeUnits = null;
  }
  if (!currentUser) return;

  const col = collection(db, "emergencies");
  const q = query(col, limit(pageSize));

  unsubscribeEmergencies = onSnapshot(
    q,
    (snapshot) => {
      const list = [];
      snapshot.forEach((docSnap) => {
        const inc = normalizeIncident(docSnap.id, docSnap.data());
        if (inc.archived && currentUserRole !== "admin") return;
        if (
          currentUserRole === "citizen" &&
          inc.reporterUid &&
          inc.reporterUid !== currentUser.uid
        ) {
          return;
        }
        list.push(inc);
      });
      emergencies = list;
      updateStatusCounts();
      if (currentUserRole === "citizen") {
        renderCitizenTrackingList();
      } else if (currentUserRole === "responder") {
        renderResponderMdtView();
      } else {
        smartRender();
      }
      if (["responder", "dispatcher", "admin"].includes(currentUserRole)) {
        renderOperationsClusterMap();
      }
      if (["dispatcher", "admin"].includes(currentUserRole)) {
        renderAnalyticsPanel();
      }
    },
    (err) => showToast(`Live sync error: ${err.message}`, "error")
  );

  unsubscribeUnits = onSnapshot(
    collection(db, "units"),
    (snap) => {
      responseUnits = [];
      snap.forEach((d) => {
        const data = d.data();
        const coords = data.coordinates?.latitude
          ? { lat: data.coordinates.latitude, lng: data.coordinates.longitude }
          : { lat: 28.6139, lng: 77.209 };
        responseUnits.push({
          id: d.id,
          name: data.name || d.id,
          type: data.type || "Rescue",
          status: data.status || "available",
          coordinates: coords,
          capacity: Number(data.capacity || 4),
          contactPhone: data.contactPhone || "112",
        });
      });
      renderUnitsList();
      if (["responder", "dispatcher", "admin"].includes(currentUserRole)) {
        renderOperationsClusterMap();
      }
      if (currentUserRole === "responder") {
        renderResponderMdtView();
      }
    },
    () => {
      responseUnits = [];
    }
  );
}

// ============ GEOCODING (PROXY + PHOTON FALLBACK) & GPS ============
async function searchLocations(queryText) {
  try {
    const proxyRes = await fetch(`/api/geocode?q=${encodeURIComponent(queryText)}&lang=${lang}`);
    if (proxyRes.ok) {
      const payload = await proxyRes.json();
      if (Array.isArray(payload.results) && payload.results.length > 0) {
        return payload.results;
      }
    }
  } catch {
    // Fallback to Photon API directly
  }
  const res = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(queryText)}&limit=6&lang=en`
  );
  const data = await res.json();
  return (data.features || [])
    .map((f) => {
      const coords = f.geometry?.coordinates;
      if (!coords) return null;
      const p = f.properties || {};
      const mainText = p.name || p.street || p.city || queryText;
      const subText = [p.district, p.city, p.state, p.country]
        .filter((x) => x && x !== mainText)
        .slice(0, 3)
        .join(", ");
      return {
        displayName: subText ? `${mainText}, ${subText}` : mainText,
        mainText,
        subText,
        lat: Number(coords[1]),
        lng: Number(coords[0]),
      };
    })
    .filter(Boolean);
}

function setDropdownMessage(text, isError = false) {
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

function handleLocationInput(e) {
  const q = e.target.value.trim();
  if (q.length < 2) {
    closeDropdown();
    return;
  }
  clearTimeout(ddDebounce);
  ddDebounce = setTimeout(async () => {
    setDropdownMessage("🔍 Searching...");
    try {
      ddItems = await searchLocations(q);
      ddActiveIdx = -1;
      renderDropdown(ddItems);
    } catch {
      setDropdownMessage("Connection error", true);
    }
  }, 280);
}

function renderDropdown(results) {
  const dd = document.getElementById("locationDropdown");
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

function selectLocation(idx) {
  const place = ddItems[idx];
  if (!place) return;
  document.getElementById("location").value = place.displayName;
  selectedCoords = { lat: place.lat, lng: place.lng };
  updateComputedDistanceDisplay(selectedCoords);
  closeDropdown();
  showLocationCoords(place.lat, place.lng, place.displayName);
}

function updateComputedDistanceDisplay(coords) {
  const distKm = computeHaversineKm(
    CONTROL_ROOM_COORDS.lat,
    CONTROL_ROOM_COORDS.lng,
    coords.lat,
    coords.lng
  );
  const distEl = document.getElementById("distance");
  if (distEl) distEl.value = String(distKm);
}

function closeDropdown() {
  const dd = document.getElementById("locationDropdown");
  if (dd) {
    dd.classList.add("hidden");
    dd.replaceChildren();
  }
  document.getElementById("location")?.setAttribute("aria-expanded", "false");
  ddItems = [];
  ddActiveIdx = -1;
}

// ============ MAPS (DRAGGABLE PICKER + CLUSTERED OPERATIONS MAP) ============
function showLocationCoords(lat, lng, label) {
  const mapEl = document.getElementById("map");
  if (!mapEl) return;
  mapEl.classList.remove("hidden");
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (Number.isNaN(numLat) || Number.isNaN(numLng)) return;

  if (!pickerMap) {
    pickerMap = L.map("map").setView([numLat, numLng], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(pickerMap);
    pickerMap.on("click", (e) => {
      const pos = e.latlng;
      selectedCoords = {
        lat: Math.round(pos.lat * 1000000) / 1000000,
        lng: Math.round(pos.lng * 1000000) / 1000000,
      };
      if (pickerMarker) {
        pickerMarker.setLatLng(pos);
      }
      updateComputedDistanceDisplay(selectedCoords);
    });
  } else {
    pickerMap.setView([numLat, numLng], 15);
  }

  if (pickerMarker) pickerMarker.remove();
  const popupNode = document.createElement("div");
  popupNode.textContent = `📍 ${label} (Drag pin to refine)`;
  pickerMarker = L.marker([numLat, numLng], { draggable: true })
    .addTo(pickerMap)
    .bindPopup(popupNode)
    .openPopup();

  pickerMarker.on("dragend", () => {
    const pos = pickerMarker.getLatLng();
    selectedCoords = {
      lat: Math.round(pos.lat * 1000000) / 1000000,
      lng: Math.round(pos.lng * 1000000) / 1000000,
    };
    updateComputedDistanceDisplay(selectedCoords);
  });

  setTimeout(() => pickerMap?.invalidateSize(), 120);
}

function renderOperationsClusterMap() {
  const container = document.getElementById("operationsMap");
  if (!container || container.closest(".hidden")) return;

  if (!operationsMap) {
    operationsMap = L.map("operationsMap").setView(
      [CONTROL_ROOM_COORDS.lat, CONTROL_ROOM_COORDS.lng],
      11
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(operationsMap);
    operationsLayerGroup = L.layerGroup().addTo(operationsMap);
    operationsMap.on("zoomend", () => renderOperationsClusterMap());
  }

  setTimeout(() => operationsMap?.invalidateSize(), 100);
  if (!operationsLayerGroup) return;
  operationsLayerGroup.clearLayers();

  const crPopup = document.createElement("div");
  crPopup.textContent = "🏢 Central Dispatch Control Room";
  L.circleMarker([CONTROL_ROOM_COORDS.lat, CONTROL_ROOM_COORDS.lng], {
    radius: 9,
    color: "#38bdf8",
    fillColor: "#0ea5e9",
    fillOpacity: 0.9,
    weight: 2,
  })
    .bindPopup(crPopup)
    .addTo(operationsLayerGroup);

  const activeIncidents = emergencies.filter(
    (inc) =>
      inc.coordinates &&
      !["resolved", "Resolved", "closed", "cancelled", "false_alarm"].includes(inc.status)
  );

  activeIncidents.forEach((inc) => {
    const tc = TYPE_COLORS[inc.type] || TYPE_COLORS.Minor;
    const popup = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = `${inc.emoji || tc.emoji} ${inc.type} (${inc.priority})`;
    const sub = document.createElement("div");
    sub.textContent = `${inc.location} · Status: ${inc.status}`;
    popup.append(strong, sub);

    L.circleMarker([inc.coordinates.lat, inc.coordinates.lng], {
      radius: inc.priority === "Critical" ? 11 : 8,
      color: tc.hex,
      fillColor: tc.hex,
      fillOpacity: 0.8,
      weight: 2,
    })
      .bindPopup(popup)
      .addTo(operationsLayerGroup);
  });

  responseUnits.forEach((u) => {
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
      .addTo(operationsLayerGroup);
  });
}

// ============ IMAGE HANDLING ============
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      reject(new Error("Unsupported image format. Use JPEG, PNG, or WebP."));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("Image exceeds 5 MB limit."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============ REPORT SUBMISSION ============
async function reportEmergency(e) {
  if (e && typeof e.preventDefault === "function") e.preventDefault();
  if (!currentUser) {
    showToast("Please sign in first to submit an emergency report.", "warning");
    return;
  }

  const consentCheck = document.getElementById("consentCheck");
  if (consentCheck && !consentCheck.checked) {
    showToast("Please confirm that this emergency report is genuine.", "warning");
    return;
  }

  const now = Date.now();
  while (submissionTimestamps.length && now - submissionTimestamps[0] > 300_000) {
    submissionTimestamps.shift();
  }
  if (submissionTimestamps.length >= 4) {
    showToast("Rate limit reached (max 4 reports per 5 minutes).", "warning");
    return;
  }

  const type = document.getElementById("type").value;
  const reportedSeverity = document.getElementById("reportedSeverity")?.value || "high";
  const peopleAffected = Number(document.getElementById("peopleAffected")?.value || 1);
  const location = document.getElementById("location").value.trim();
  const desc = document.getElementById("description").value.trim();
  const manualDist = Number(document.getElementById("distance").value || 3.5);
  const file = document.getElementById("image").files[0];

  const vulnerabilityFlags = [];
  document.querySelectorAll(".vuln-checkbox:checked").forEach((cb) => {
    vulnerabilityFlags.push(cb.value);
  });

  if (!location || !desc || desc.length < 5) {
    showToast("Please enter a valid location and description (min 5 chars).", "warning");
    return;
  }

  const distanceKm = selectedCoords
    ? computeHaversineKm(
        CONTROL_ROOM_COORDS.lat,
        CONTROL_ROOM_COORDS.lng,
        selectedCoords.lat,
        selectedCoords.lng
      )
    : Math.max(0, manualDist);

  const priorityData = calculatePriorityScore({
    type,
    reportedSeverity,
    peopleAffected,
    vulnerabilityFlags,
    distanceKm,
  });

  const btn = document.getElementById("submitBtn");
  const btnText = document.getElementById("submitBtnText");
  btnText.textContent = `⏳ ${t("submittingBtn")}`;
  btn.disabled = true;

  let imgURL = "";
  if (file) {
    try {
      imgURL = await fileToBase64(file);
    } catch (err) {
      showToast(err.message || "Image processing failed.", "error");
      btnText.textContent = `🚨 ${t("submitReportBtn")}`;
      btn.disabled = false;
      return;
    }
  }

  if (currentUser?.uid?.startsWith("demo-")) {
    const demoId = `demo-inc-${Date.now()}`;
    const newInc = {
      id: demoId,
      uid: currentUser.uid,
      reporterUid: currentUser.uid,
      type,
      reportedSeverity,
      peopleAffected,
      vulnerabilityFlags,
      location,
      desc,
      coordinates: selectedCoords || { lat: 28.6139, lng: 77.209 },
      geohash: selectedCoords ? encodeGeohash(selectedCoords.lat, selectedCoords.lng) : "",
      distance: distanceKm,
      priorityScore: priorityData.score,
      priority: priorityData.level,
      weight: priorityData.weight,
      status: "reported",
      assignedUnitIds: [],
      assignedResponderUids: [],
      mergedIntoId: null,
      duplicateCount: 0,
      img: imgURL,
      rating: null,
      feedback: "",
      abuseFlags: 0,
      archived: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      timestamp: Date.now(),
    };
    emergencies.unshift(newInc);
    submissionTimestamps.push(Date.now());
    updateStatusCounts();
    if (currentUserRole === "citizen") {
      renderCitizenTrackingList();
    } else {
      smartRender();
    }
    showToast("Emergency reported! Live CAD queue notified.", "success");
    ["location", "description"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const pa = document.getElementById("peopleAffected");
    if (pa) pa.value = "1";
    document.querySelectorAll(".vuln-checkbox").forEach((cb) => {
      cb.checked = false;
    });
    const fi = document.getElementById("image");
    if (fi) fi.value = "";
    const preview = document.getElementById("imagePreview");
    if (preview) {
      preview.removeAttribute("src");
      preview.classList.add("hidden");
    }
    const fl = document.getElementById("fileLabel");
    if (fl) fl.textContent = t("fileDropPrompt");
    selectedCoords = null;
    closeDropdown();
    btnText.textContent = `🚨 ${t("submitReportBtn")}`;
    btn.disabled = false;
    return;
  }

  try {
    const docRef = await addDoc(collection(db, "emergencies"), {
      uid: currentUser.uid,
      reporterUid: currentUser.uid,
      type,
      reportedSeverity,
      peopleAffected,
      vulnerabilityFlags,
      location,
      desc,
      coordinates: selectedCoords
        ? new GeoPoint(selectedCoords.lat, selectedCoords.lng)
        : new GeoPoint(
            CONTROL_ROOM_COORDS.lat + (Math.random() - 0.5) * 0.03,
            CONTROL_ROOM_COORDS.lng + (Math.random() - 0.5) * 0.03
          ),
      geohash: selectedCoords ? encodeGeohash(selectedCoords.lat, selectedCoords.lng) : "",
      distance: distanceKm,
      priorityScore: priorityData.score,
      priority: priorityData.level,
      weight: priorityData.weight,
      status: "reported",
      assignedUnitIds: [],
      assignedResponderUids: [],
      mergedIntoId: null,
      duplicateCount: 0,
      img: imgURL,
      rating: null,
      feedback: "",
      abuseFlags: 0,
      archived: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      timestamp: Date.now(),
    });

    await addDoc(collection(db, "emergencies", docRef.id, "timeline"), {
      incidentId: docRef.id,
      actorUid: currentUser.uid,
      actorRole: currentUserRole,
      action: "created",
      toState: "reported",
      note: `Incident reported (${type}, ${priorityData.level} priority, score ${priorityData.score})`,
      createdAt: serverTimestamp(),
    });

    submissionTimestamps.push(Date.now());
    showToast("Emergency reported! Dispatch has been notified live.", "success");

    ["location", "description"].forEach((id) => {
      document.getElementById(id).value = "";
    });
    document.getElementById("peopleAffected").value = "1";
    document.querySelectorAll(".vuln-checkbox").forEach((cb) => {
      cb.checked = false;
    });
    document.getElementById("image").value = "";
    const preview = document.getElementById("imagePreview");
    preview.removeAttribute("src");
    preview.classList.add("hidden");
    document.getElementById("fileLabel").textContent = t("fileDropPrompt");
    selectedCoords = null;
    closeDropdown();
  } catch (err) {
    showToast("Error saving report: " + err.message, "error");
  } finally {
    btnText.textContent = `🚨 ${t("submitReportBtn")}`;
    btn.disabled = false;
  }
}

// ============ DASHBOARD & CARD RENDERING ============
function updateStatusCounts() {
  const counts = { Fire: 0, Medical: 0, Accident: 0, Police: 0, Minor: 0 };
  emergencies.forEach((e) => {
    if (counts[e.type] !== undefined) counts[e.type]++;
  });
  document.getElementById("count-fire").textContent = String(counts.Fire);
  document.getElementById("count-medical").textContent = String(counts.Medical);
  document.getElementById("count-accident").textContent = String(counts.Accident);
  document.getElementById("count-police").textContent = String(counts.Police);
  document.getElementById("count-minor").textContent = String(counts.Minor);
  document.getElementById("count-total").textContent = String(emergencies.length);
}

function getFilteredAndSortedIncidents() {
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

function buildFeedbackSection(incident) {
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
  select.setAttribute("aria-label", "Select rating from 1 to 5 stars");
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
      if (currentUser?.uid?.startsWith("demo-")) {
        incident.rating = numRating;
        incident.feedback = textarea.value.trim();
        if (currentUserRole === "citizen") {
          renderCitizenTrackingList();
        } else {
          smartRender();
        }
        showToast("Feedback submitted! Thank you.", "success");
        return;
      }
      await updateDoc(doc(db, "emergencies", incident.id), {
        rating: numRating,
        feedback: textarea.value.trim(),
        updatedAt: serverTimestamp(),
      });
      showToast("Feedback submitted! Thank you.", "success");
    } catch (err) {
      showToast("Error submitting feedback: " + err.message, "error");
    }
  });

  container.append(labelP, select, textarea, submitBtn);
  return container;
}

function createEmergencyCardDOM(e) {
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
    imgEl.alt = `${e.type} attachment`;
    imgEl.loading = "lazy";
    card.appendChild(imgEl);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "type-banner-placeholder";
    placeholder.style.background = `linear-gradient(135deg, ${tc.hex}22, ${tc.hex}44)`;
    const emojiSpan = document.createElement("span");
    emojiSpan.style.fontSize = "2.5rem";
    emojiSpan.textContent = tc.emoji;
    const labelSpan = document.createElement("span");
    labelSpan.style.cssText = `font-family:var(--font-head);font-size:1.1rem;font-weight:700;color:${tc.hex};letter-spacing:2px`;
    labelSpan.textContent = String(e.type || "INCIDENT").toUpperCase();
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
  const locStrong = document.createElement("strong");
  locStrong.textContent = `📍 ${e.location}`;
  locRow.appendChild(locStrong);

  const distRow = document.createElement("div");
  distRow.className = "ec-info";
  distRow.textContent = `📏 ${e.distance} km · 👥 ${e.peopleAffected} affected`;

  const descP = document.createElement("p");
  descP.className = "ec-desc";
  descP.textContent = e.desc;

  const statusDiv = document.createElement("div");
  statusDiv.className = "status";

  const timelineBtn = document.createElement("button");
  timelineBtn.type = "button";
  timelineBtn.className = "lang-btn";
  timelineBtn.style.cssText = "width:100%;margin-bottom:6px";
  timelineBtn.textContent = "📜 View Incident Timeline";
  timelineBtn.addEventListener("click", () => openTimelineModal(e));

  const actionsSlot = document.createElement("div");
  actionsSlot.className = "card-actions-slot";

  content.append(header, locRow, distRow, descP, statusDiv, timelineBtn, actionsSlot);
  card.appendChild(content);
  syncCardDynamicState(card, e);
  return card;
}

function syncCardDynamicState(card, e) {
  const isResolved = ["resolved", "Resolved", "closed"].includes(e.status);
  const isStaff = ["responder", "dispatcher", "admin"].includes(currentUserRole);
  const isDispatcherOrAdmin = ["dispatcher", "admin"].includes(currentUserRole);
  const isAdmin = currentUserRole === "admin";
  const isOwner = Boolean(currentUser && (e.reporterUid === currentUser.uid || e.uid === currentUser.uid));

  const statusDiv = card.querySelector(".status");
  if (statusDiv) {
    statusDiv.className = `status ${isResolved ? "status-resolved" : "status-pending"}`;
    statusDiv.replaceChildren();
    const icon = document.createElement("span");
    icon.textContent = isResolved ? "✅" : "🟡";
    const bold = document.createElement("b");
    bold.textContent = String(e.status || "reported").toUpperCase();
    statusDiv.append(icon, document.createTextNode(" "), bold);
  }

  const slot = card.querySelector(".card-actions-slot");
  if (!slot) return;

  if (isResolved) {
    slot.querySelectorAll(".workflow-controls").forEach((n) => n.remove());
    if (isOwner || isStaff) {
      const existingFb = slot.querySelector(".feedbackDiv");
      const nowRated = e.rating ? "true" : "false";
      if (!existingFb) {
        slot.appendChild(buildFeedbackSection(e));
      } else if (existingFb.dataset.rated !== nowRated || nowRated === "true") {
        existingFb.replaceWith(buildFeedbackSection(e));
      }
    }
    return;
  }

  slot.querySelector(".feedbackDiv")?.remove();
  slot.querySelectorAll(".workflow-controls").forEach((n) => n.remove());

  const wfBox = document.createElement("div");
  wfBox.className = "workflow-controls";

  const allowedNext = (VALID_STATE_TRANSITIONS[e.status] || []).filter((next) =>
    canTransitionState(e.status, next, currentUserRole, isOwner)
  );

  allowedNext.forEach((nextState) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      nextState === "cancelled" || nextState === "false_alarm" ? "deleteBtn" : "resolveBtn";
    btn.style.marginBottom = "6px";
    btn.textContent = `→ Mark as ${nextState.replace("_", " ").toUpperCase()}`;
    btn.addEventListener("click", async () => {
      try {
        if (currentUser?.uid?.startsWith("demo-")) {
          e.status = nextState;
          if (nextState === "resolved" || nextState === "Resolved") {
            e.resolvedAtMs = Date.now();
          }
          smartRender();
          renderAnalyticsPanel();
          updateStatusCounts();
          showToast(`Incident status updated to ${nextState}.`, "success");
          return;
        }
        const payload = { status: nextState, updatedAt: serverTimestamp() };
        if (nextState === "resolved" || nextState === "Resolved") {
          payload.resolvedAt = serverTimestamp();
        }
        await updateDoc(doc(db, "emergencies", e.id), payload);
        await addDoc(collection(db, "emergencies", e.id, "timeline"), {
          incidentId: e.id,
          actorUid: currentUser.uid,
          actorRole: currentUserRole,
          action: "status_change",
          fromState: e.status,
          toState: nextState,
          note: `Transitioned ${e.status} → ${nextState}`,
          createdAt: serverTimestamp(),
        });
        showToast(`Incident status updated to ${nextState}.`, "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
    wfBox.appendChild(btn);
  });

  if (isDispatcherOrAdmin && responseUnits.filter((u) => u.status === "available").length > 0) {
    const avail = responseUnits.filter((u) => u.status === "available");
    const assignWrap = document.createElement("div");
    assignWrap.style.cssText = "display:flex;gap:6px;margin-bottom:6px";
    const unitSelect = document.createElement("select");
    avail.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.name} (${u.type})`;
      unitSelect.appendChild(opt);
    });
    const dispatchBtn = document.createElement("button");
    dispatchBtn.type = "button";
    dispatchBtn.className = "resolveBtn";
    dispatchBtn.style.cssText = "width:auto;padding:8px 12px;margin-bottom:0";
    dispatchBtn.textContent = "🚓 Dispatch";
    dispatchBtn.addEventListener("click", async () => {
      const chosen = avail.find((u) => u.id === unitSelect.value);
      if (!chosen) return;
      try {
        if (currentUser?.uid?.startsWith("demo-")) {
          e.status = "assigned";
          e.assignedUnitIds = [...(e.assignedUnitIds || []), chosen.id];
          chosen.status = "dispatched";
          chosen.currentIncidentId = e.id;
          smartRender();
          renderUnitsList();
          renderOperationsClusterMap();
          showToast(`Dispatched ${chosen.name} to ${e.location}.`, "success");
          return;
        }
        await updateDoc(doc(db, "emergencies", e.id), {
          status: "assigned",
          assignedUnitIds: [...(e.assignedUnitIds || []), chosen.id],
          updatedAt: serverTimestamp(),
        });
        await updateDoc(doc(db, "units", chosen.id), {
          status: "dispatched",
          currentIncidentId: e.id,
          updatedAt: serverTimestamp(),
        });
        showToast(`Dispatched ${chosen.name} to ${e.location}.`, "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
    assignWrap.append(unitSelect, dispatchBtn);
    wfBox.appendChild(assignWrap);
  }

  if (isAdmin) {
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "deleteBtn";
    archiveBtn.textContent = "🗑️ Archive Report (Admin)";
    archiveBtn.addEventListener("click", async () => {
      const ok = await showConfirmModal(
        "Archive Emergency Report",
        "Soft-delete this incident and record an immutable entry in auditLogs?"
      );
      if (!ok) return;
      try {
        if (currentUser?.uid?.startsWith("demo-")) {
          e.archived = true;
          smartRender();
          updateStatusCounts();
          showToast("Incident archived.", "info");
          return;
        }
        await updateDoc(doc(db, "emergencies", e.id), {
          archived: true,
          updatedAt: serverTimestamp(),
        });
        await addDoc(collection(db, "auditLogs"), {
          incidentId: e.id,
          actorUid: currentUser.uid,
          actorRole: currentUserRole,
          action: "archived",
          createdAt: serverTimestamp(),
        });
        showToast("Incident archived.", "info");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
    wfBox.appendChild(archiveBtn);
  }

  slot.appendChild(wfBox);
}

function smartRender() {
  const grid = document.getElementById("emergencyGrid");
  if (!grid) return;

  const filtered = getFilteredAndSortedIncidents();

  Array.from(grid.querySelectorAll(".emergency-card")).forEach((card) => {
    if (!emergencies.some((e) => e.id === card.dataset.id)) card.remove();
  });

  const existingEmptyMsg = grid.querySelector(".empty-state-msg");

  if (filtered.length === 0) {
    Array.from(grid.querySelectorAll(".emergency-card")).forEach((card) => {
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
  Array.from(grid.querySelectorAll(".emergency-card")).forEach((card) => {
    card.style.display = visibleIds.has(card.dataset.id) ? "" : "none";
  });

  filtered.forEach((e) => {
    const existingCard = grid.querySelector(`[data-id="${CSS.escape(e.id)}"]`);
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

function updateNotifications() {
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
    div.className = `notification notif-${String(e.type || "minor").toLowerCase()} notif-default`;
    const wrap = document.createElement("div");
    const titleLine = document.createElement("div");
    const strongType = document.createElement("strong");
    strongType.textContent = e.type;
    titleLine.append(
      document.createTextNode(`${tc.emoji} `),
      strongType,
      document.createTextNode(` at ${e.location}`)
    );
    const mins = Math.max(0, Math.floor((Date.now() - e.createdAtMs) / 60000));
    const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
    const timeLine = document.createElement("div");
    timeLine.className = "notif-time";
    timeLine.textContent = `${e.priority} Priority · ${ago}`;
    wrap.append(titleLine, timeLine);
    div.appendChild(wrap);
    panel.appendChild(div);
  });
}

// ============ UNITS, ANALYTICS, TIMELINE & ADMIN ============
function renderUnitsList() {
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
    item.append(nameStrong, statusBadge);
    container.appendChild(item);
  });
}

function renderAnalyticsPanel() {
  const container = document.getElementById("analyticsContent");
  if (!container) return;
  container.replaceChildren();

  const total = emergencies.length;
  const resolved = emergencies.filter((e) => ["resolved", "Resolved", "closed"].includes(e.status));
  const ratePct = total > 0 ? Math.round((resolved.length / total) * 100) : 0;
  const rated = emergencies.filter((e) => typeof e.rating === "number" && e.rating >= 1);
  const avgRating =
    rated.length > 0
      ? Math.round((rated.reduce((s, e) => s + e.rating, 0) / rated.length) * 10) / 10
      : 0;

  const kpiGrid = document.createElement("div");
  kpiGrid.className = "analytics-kpi-grid";
  [
    { label: "Total Incidents", val: String(total) },
    { label: "Resolution Rate", val: `${ratePct}%` },
    { label: "Active Fleet Units", val: String(responseUnits.length) },
    { label: "Avg Citizen Rating", val: avgRating > 0 ? `⭐ ${avgRating} / 5` : "—" },
  ].forEach((k) => {
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
  container.appendChild(kpiGrid);
}

async function openTimelineModal(incident) {
  const dialog = document.getElementById("timelineDialog");
  const listEl = document.getElementById("timelineList");
  const titleEl = document.getElementById("timelineDialogTitle");
  if (!dialog || !listEl || !titleEl) return;
  titleEl.textContent = `Incident Timeline — ${incident.type} (${incident.location})`;
  listEl.replaceChildren();
  dialog.showModal();

  try {
    const snap = await getDocs(collection(db, "emergencies", incident.id, "timeline"));
    const items = [];
    snap.forEach((d) => items.push(d.data()));
    if (items.length === 0) {
      const p = document.createElement("p");
      p.textContent = `Status: ${incident.status} (Location: ${incident.location})`;
      listEl.appendChild(p);
      return;
    }
    items.forEach((ev) => {
      const row = document.createElement("div");
      row.className = "timeline-row";
      row.textContent = `${String(ev.actorRole || "operator").toUpperCase()}: ${ev.note}`;
      listEl.appendChild(row);
    });
  } catch (err) {
    const p = document.createElement("p");
    p.textContent = "Timeline event recorded at creation.";
    listEl.appendChild(p);
  }
}

async function loadAdminUsersTable() {
  const tbody = document.getElementById("adminUsersBody");
  if (!tbody) return;
  tbody.replaceChildren();
  try {
    const snap = await getDocs(collection(db, "users"));
    snap.forEach((d) => {
      const u = d.data();
      const tr = document.createElement("tr");
      const tdEmail = document.createElement("td");
      tdEmail.textContent = u.email || d.id;
      const tdRole = document.createElement("td");
      tdRole.textContent = String(u.role || "citizen").toUpperCase();
      tr.append(tdEmail, tdRole);
      tbody.appendChild(tr);
    });
  } catch {
    // Ignore if empty
  }
}

function applyTranslations() {
  const setTxt = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const isAuthority = selectedLoginPortal === "authority";
  setTxt("title", t("appTitle"));
  setTxt("brandSubtitle", t("appSubtitle"));
  setTxt(
    "authTitle",
    isAuthority
      ? signupMode
        ? "Department Staff Registration"
        : "Department Staff Login"
      : signupMode
        ? t("signupTitle")
        : "Public Citizen Access"
  );
  setTxt(
    "authSubtitle",
    isAuthority
      ? "112 Control Room Operators, Police / Fire Responders & Admins"
      : "Report an emergency & track assistance status in real time"
  );
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
}

function exportCsv() {
  const rows = getFilteredAndSortedIncidents().map((e) => [
    e.id,
    e.type,
    e.priority,
    e.priorityScore,
    e.status,
    `"${String(e.location || "").replace(/"/g, '""')}"`,
    e.distance,
    e.peopleAffected,
  ]);
  const csv = [
    "ID,Type,Priority,Score,Status,Location,DistanceKm,PeopleAffected",
    ...rows.map((r) => r.join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cers-incidents.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ============ SAMPLE DEMO DATA & INSTANT EVALUATOR MODE ============
const SAMPLE_DEMO_INCIDENTS = [
  {
    id: "demo-inc-1",
    uid: "demo-citizen-uid",
    reporterUid: "demo-citizen-uid",
    type: "Fire",
    reportedSeverity: "critical",
    peopleAffected: 6,
    vulnerabilityFlags: ["elderly", "flammable"],
    location: "Connaught Place Block B, Central Delhi",
    desc: "Commercial building electrical transformer caught fire. Thick smoke spreading to upper floors.",
    coordinates: { lat: 28.6315, lng: 77.2167 },
    geohash: "ttnfvh5qx",
    distance: 1.8,
    priorityScore: 92,
    priority: "CRITICAL",
    weight: 92,
    status: "assigned",
    assignedUnitIds: ["unit-engine-1"],
    assignedResponderUids: ["demo-responder-uid"],
    mergedIntoId: null,
    duplicateCount: 0,
    img: "",
    rating: null,
    feedback: "",
    abuseFlags: 0,
    archived: false,
    createdAtMs: Date.now() - 480000,
    updatedAtMs: Date.now() - 120000,
    timestamp: Date.now() - 480000,
  },
  {
    id: "demo-inc-2",
    uid: "demo-citizen-uid",
    reporterUid: "demo-citizen-uid",
    type: "Medical",
    reportedSeverity: "critical",
    peopleAffected: 1,
    vulnerabilityFlags: ["children"],
    location: "Karol Bagh Market, New Delhi",
    desc: "Pedestrian collapsed with chest pain and breathing difficulty outside metro station.",
    coordinates: { lat: 28.6517, lng: 77.1906 },
    geohash: "ttnfvsdv1",
    distance: 4.2,
    priorityScore: 84,
    priority: "CRITICAL",
    weight: 84,
    status: "en_route",
    assignedUnitIds: ["unit-ems-2"],
    assignedResponderUids: ["demo-responder-uid"],
    mergedIntoId: null,
    duplicateCount: 0,
    img: "",
    rating: null,
    feedback: "",
    abuseFlags: 0,
    archived: false,
    createdAtMs: Date.now() - 900000,
    updatedAtMs: Date.now() - 300000,
    timestamp: Date.now() - 900000,
  },
  {
    id: "demo-inc-3",
    uid: "demo-citizen-uid",
    reporterUid: "demo-citizen-uid",
    type: "Accident",
    reportedSeverity: "moderate",
    peopleAffected: 2,
    vulnerabilityFlags: [],
    location: "Ring Road near AIIMS Flyover",
    desc: "Two-car collision blocking middle lane. No trapped passengers, minor injuries.",
    coordinates: { lat: 28.5672, lng: 77.2100 },
    geohash: "ttnfeh28z",
    distance: 5.6,
    priorityScore: 65,
    priority: "HIGH",
    weight: 65,
    status: "verified",
    assignedUnitIds: [],
    assignedResponderUids: [],
    mergedIntoId: null,
    duplicateCount: 0,
    img: "",
    rating: null,
    feedback: "",
    abuseFlags: 0,
    archived: false,
    createdAtMs: Date.now() - 1500000,
    updatedAtMs: Date.now() - 600000,
    timestamp: Date.now() - 1500000,
  },
  {
    id: "demo-inc-4",
    uid: "demo-citizen-uid",
    reporterUid: "demo-citizen-uid",
    type: "Police",
    reportedSeverity: "low",
    peopleAffected: 1,
    vulnerabilityFlags: [],
    location: "Lajpat Nagar Central Market",
    desc: "Shoplifting disturbance reported at electronics store. Situation stable.",
    coordinates: { lat: 28.5700, lng: 77.2400 },
    geohash: "ttnff0021",
    distance: 7.1,
    priorityScore: 35,
    priority: "LOW",
    weight: 35,
    status: "resolved",
    assignedUnitIds: ["unit-patrol-3"],
    assignedResponderUids: ["demo-responder-uid"],
    mergedIntoId: null,
    duplicateCount: 0,
    img: "",
    rating: 5,
    feedback: "Police unit arrived in 7 minutes and resolved the issue safely.",
    abuseFlags: 0,
    archived: false,
    createdAtMs: Date.now() - 3600000,
    updatedAtMs: Date.now() - 1800000,
    resolvedAtMs: Date.now() - 1800000,
    timestamp: Date.now() - 3600000,
  },
];

const SAMPLE_DEMO_UNITS = [
  {
    id: "unit-engine-1",
    name: "Engine 101 (Heavy Water Tender)",
    type: "Fire",
    status: "busy",
    coordinates: { lat: 28.632, lng: 77.217 },
    capacity: 6,
    contactPhone: "+91 11 2341 2222",
  },
  {
    id: "unit-ems-2",
    name: "EMS 204 (Advanced Life Support)",
    type: "Medical",
    status: "en_route",
    coordinates: { lat: 28.65, lng: 77.192 },
    capacity: 3,
    contactPhone: "+91 11 2341 3333",
  },
  {
    id: "unit-patrol-3",
    name: "Patrol PCR-12 (Central Sector)",
    type: "Police",
    status: "available",
    coordinates: { lat: 28.618, lng: 77.211 },
    capacity: 2,
    contactPhone: "+91 11 2341 4444",
  },
  {
    id: "unit-rescue-4",
    name: "Rescue Squad 4 (Disaster Response)",
    type: "Rescue",
    status: "available",
    coordinates: { lat: 28.625, lng: 77.22 },
    capacity: 8,
    contactPhone: "+91 11 2341 5555",
  },
];

function loginAsDemo(role, email) {
  currentUser = {
    uid: `demo-${role}-uid`,
    email: email,
    displayName: `Demo ${role.toUpperCase()}`,
  };
  currentUserRole = role;
  const roleSwitcher = document.getElementById("roleSwitcher");
  if (roleSwitcher) roleSwitcher.value = role;

  if (emergencies.length === 0) {
    emergencies = JSON.parse(JSON.stringify(SAMPLE_DEMO_INCIDENTS));
  }
  if (responseUnits.length === 0) {
    responseUnits = JSON.parse(JSON.stringify(SAMPLE_DEMO_UNITS));
  }

  document.getElementById("authPage")?.classList.add("hidden");
  document.getElementById("app")?.classList.remove("hidden");
  updateRoleVisibility();
  applyTranslations();
  updateStatusCounts();
  renderUnitsList();
  showToast(`Entered ${role.toUpperCase()} Portal in Instant Demo Mode`, "success");
}

// ============ INIT EVENT LISTENERS ============
function initApp() {
  applyTranslations();

  document.querySelectorAll(".portal-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".portal-tab").forEach((tEl) => {
        tEl.classList.remove("active");
        tEl.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      selectedLoginPortal = tab.dataset.portal || "citizen";
      document
        .getElementById("authorityRoleGroup")
        ?.classList.toggle("hidden", selectedLoginPortal !== "authority");
      applyTranslations();
    });
  });

  // QUICK ONE-CLICK DEMO BUTTONS
  document.getElementById("demoCitizenBtn")?.addEventListener("click", () => {
    loginAsDemo("citizen", "citizen.demo@city.gov");
  });
  document.getElementById("demoDispatcherBtn")?.addEventListener("click", () => {
    loginAsDemo("dispatcher", "dispatcher.911@city.gov");
  });
  document.getElementById("demoResponderBtn")?.addEventListener("click", () => {
    loginAsDemo("responder", "responder.fire1@city.gov");
  });

  document.getElementById("authForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    if (!email || !password) {
      showToast("Please enter email and password.", "warning");
      return;
    }
    try {
      if (signupMode) {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        sendEmailVerification(cred.user).catch(() => {});
        showToast("Account created! Welcome to CERS.", "success");
      } else {
        await signInWithEmailAndPassword(auth, email, password);
        showToast("Signed in to CERS.", "success");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("toggleAuthBtn")?.addEventListener("click", () => {
    signupMode = !signupMode;
    applyTranslations();
  });

  document.getElementById("resetPasswordBtn")?.addEventListener("click", async () => {
    const email = document.getElementById("username").value.trim();
    if (!email) {
      showToast("Enter your email address above first.", "warning");
      return;
    }
    try {
      await sendPasswordResetEmail(auth, email);
      showToast(`Password reset email sent to ${email}.`, "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.getElementById("roleSwitcher")?.addEventListener("change", (e) => {
    currentUserRole = e.target.value;
    updateRoleVisibility();
    startRealtimeSubscriptions();
    showToast(`Switched active portal view to ${currentUserRole.toUpperCase()}.`, "info");
  });

  document.getElementById("langToggleBtn")?.addEventListener("click", () => {
    lang = lang === "en" ? "hi" : "en";
    localStorage.setItem(LOCALE_STORAGE_KEY, lang);
    applyTranslations();
    smartRender();
  });

  document.getElementById("reducedMotionBtn")?.addEventListener("click", () => {
    document.body.classList.toggle("reduced-motion");
    showToast(
      document.body.classList.contains("reduced-motion")
        ? "Reduced motion enabled (scanlines & animations off)."
        : "Standard animations enabled.",
      "info"
    );
  });

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    currentUser = null;
    if (unsubscribeEmergencies) {
      unsubscribeEmergencies();
      unsubscribeEmergencies = null;
    }
    if (unsubscribeUnits) {
      unsubscribeUnits();
      unsubscribeUnits = null;
    }
    emergencies = [];
    document.getElementById("authPage")?.classList.remove("hidden");
    document.getElementById("app")?.classList.add("hidden");
    signOut(auth).catch(() => {});
    showToast("Signed out.", "info");
  });

  document.querySelectorAll(".type-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".type-pill").forEach((p) => {
        p.classList.remove("active");
        p.setAttribute("aria-checked", "false");
      });
      pill.classList.add("active");
      pill.setAttribute("aria-checked", "true");
      document.getElementById("type").value = pill.dataset.val;
    });
  });

  const locInput = document.getElementById("location");
  locInput?.addEventListener("input", handleLocationInput);
  locInput?.addEventListener("keydown", (e) => {
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

  document.getElementById("geoLocateBtn")?.addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      showToast("Geolocation is not supported by your browser.", "warning");
      return;
    }
    showToast("Acquiring GPS coordinates...", "info");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        selectedCoords = {
          lat: Math.round(pos.coords.latitude * 1000000) / 1000000,
          lng: Math.round(pos.coords.longitude * 1000000) / 1000000,
        };
        const label = `GPS (${selectedCoords.lat}, ${selectedCoords.lng})`;
        if (!document.getElementById("location").value.trim()) {
          document.getElementById("location").value = label;
        }
        updateComputedDistanceDisplay(selectedCoords);
        showLocationCoords(selectedCoords.lat, selectedCoords.lng, label);
        showToast("GPS locked! Drag pin to adjust.", "success");
      },
      (err) => showToast(`GPS Error: ${err.message}`, "error")
    );
  });

  document.getElementById("showMapBtn")?.addEventListener("click", async () => {
    const q = document.getElementById("location").value.trim();
    if (!q) {
      showToast("Enter a location or click GPS first.", "warning");
      return;
    }
    const res = await searchLocations(q);
    if (!res.length) {
      showToast("Location not found.", "warning");
      return;
    }
    selectedCoords = { lat: res[0].lat, lng: res[0].lng };
    updateComputedDistanceDisplay(selectedCoords);
    showLocationCoords(res[0].lat, res[0].lng, res[0].displayName);
  });

  const fileDrop = document.getElementById("fileDrop");
  const fileInput = document.getElementById("image");
  const previewImage = () => {
    const file = fileInput?.files?.[0];
    const preview = document.getElementById("imagePreview");
    const label = document.getElementById("fileLabel");
    if (file && preview && label) {
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
      label.textContent = file.name;
    }
  };
  fileDrop?.addEventListener("click", () => fileInput?.click());
  fileDrop?.addEventListener("dragover", (e) => e.preventDefault());
  fileDrop?.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      previewImage();
    } else {
      showToast("Drop a valid JPEG, PNG, or WebP image.", "warning");
    }
  });
  fileInput?.addEventListener("change", previewImage);

  document.getElementById("reportForm")?.addEventListener("submit", reportEmergency);

  document.getElementById("createUnitForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("unitName").value.trim();
    const type = document.getElementById("unitType").value;
    const capacity = Number(document.getElementById("unitCapacity").value || 4);
    const contactPhone = document.getElementById("unitPhone").value.trim() || "112";
    if (!name) return;
    try {
      await addDoc(collection(db, "units"), {
        name,
        type,
        status: "available",
        coordinates: new GeoPoint(
          CONTROL_ROOM_COORDS.lat + (Math.random() - 0.5) * 0.04,
          CONTROL_ROOM_COORDS.lng + (Math.random() - 0.5) * 0.04
        ),
        capacity,
        contactPhone,
        updatedAt: serverTimestamp(),
      });
      document.getElementById("unitName").value = "";
      showToast(`Registered response unit ${name}.`, "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.querySelectorAll(".filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      dashFilter = btn.dataset.filter || "all";
      document.querySelectorAll(".filter-pill").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      smartRender();
    });
  });

  document.getElementById("searchInput")?.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    smartRender();
  });

  document.getElementById("sortSelect")?.addEventListener("change", (e) => {
    sortBy = e.target.value;
    smartRender();
  });

  document.getElementById("exportCsvBtn")?.addEventListener("click", exportCsv);

  document.getElementById("loadMoreBtn")?.addEventListener("click", () => {
    pageSize += 25;
    startRealtimeSubscriptions();
    showToast(`Loading up to ${pageSize} incidents...`, "info");
  });

  document.getElementById("closeTimelineBtn")?.addEventListener("click", () => {
    document.getElementById("timelineDialog")?.close();
  });

  document.getElementById("privacyBtn")?.addEventListener("click", () => {
    document.getElementById("privacyDialog")?.showModal();
  });
  document.getElementById("closePrivacyBtn")?.addEventListener("click", () => {
    document.getElementById("privacyDialog")?.close();
  });
  document.getElementById("deleteAccountBtn")?.addEventListener("click", async () => {
    if (!currentUser) return;
    const ok = await showConfirmModal(
      "Delete Account & Data",
      "Permanently delete your CERS account and profile?"
    );
    if (!ok) return;
    try {
      await deleteDoc(doc(db, "users", currentUser.uid));
      await deleteUser(currentUser);
      showToast("Account deleted.", "info");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".location-wrapper")) closeDropdown();
  });
}

initApp();
