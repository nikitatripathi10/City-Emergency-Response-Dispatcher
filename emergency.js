import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, getDoc, setDoc, updateDoc, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCsQyW9xmh1lXSYY8oPmFGAETUquWJI8JY",
  authDomain: "city-emergency-dispatcher.firebaseapp.com",
  projectId: "city-emergency-dispatcher",
  storageBucket: "city-emergency-dispatcher.firebasestorage.app",
  messagingSenderId: "364720673291",
  appId: "1:364720673291:web:7a37303cce58f8bcdbad0e"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ============ STATE ============
let emergencies = [];
let signupMode = false;
let lang = "en";
let map = null;
let currentUser = null;
let currentUserRole = "citizen"; // 'citizen' | 'responder' | 'dispatcher' | 'admin'
let unsubscribeEmergencies = null;
let ddItems = [];       // dropdown result list
let ddActiveIdx = -1;   // keyboard nav index
let ddDebounce = null;  // debounce timer
let dashFilter = "all"; // dashboard filter

// ============ TYPE COLOUR MAP ============
const TYPE_COLORS = {
  Fire:     { hex: "#ff4500", emoji: "🔥", class: "banner-fire" },
  Medical:  { hex: "#00e676", emoji: "🏥", class: "banner-medical" },
  Accident: { hex: "#ff9800", emoji: "🚗", class: "banner-accident" },
  Police:   { hex: "#2979ff", emoji: "🚔", class: "banner-police" },
  Minor:    { hex: "#ab47bc", emoji: "⚠️", class: "banner-minor" },
};

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

// ============ STRICT IMAGE URL VALIDATION ============
function isValidImageSrc(src) {
  if (typeof src !== "string" || !src) return false;
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) {
    return true;
  }
  try {
    const parsed = new URL(src);
    return parsed.protocol === "https:" && parsed.hostname === "firebasestorage.googleapis.com";
  } catch {
    return false;
  }
}

// ============ AUTH STATE & RBAC ============
async function resolveUserRole(user) {
  try {
    const tokenResult = await user.getIdTokenResult();
    if (tokenResult.claims && tokenResult.claims.role) {
      return String(tokenResult.claims.role);
    }
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    if (snap.exists() && snap.data().role) {
      return String(snap.data().role);
    }
    await setDoc(userRef, {
      uid: user.uid,
      email: user.email || "",
      role: "citizen",
      preferredLang: lang,
      createdAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn("Could not resolve user role, defaulting to citizen:", err);
  }
  return "citizen";
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    currentUserRole = await resolveUserRole(user);
    const roleLabel = document.getElementById("roleLabel");
    if (roleLabel) roleLabel.textContent = currentUserRole.toUpperCase();
    document.getElementById("authPage").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    loadEmergencies();
  } else {
    currentUser = null;
    currentUserRole = "citizen";
    if (unsubscribeEmergencies) {
      unsubscribeEmergencies();
      unsubscribeEmergencies = null;
    }
    emergencies = [];
    document.getElementById("authPage").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
  }
});

// ============ AUTH TOGGLE & FORM ============
function toggleAuth() {
  signupMode = !signupMode;
  document.getElementById("authTitle").textContent = signupMode ? "Signup" : "Login";
  document.getElementById("authSubmitText").textContent = signupMode ? "Create Account" : "Login";
  document.getElementById("switchText").textContent = signupMode ? "Have account?" : "No account?";
  document.getElementById("toggleAuthBtn").textContent = signupMode ? "Login" : "Signup";
  document.getElementById("password").setAttribute(
    "autocomplete",
    signupMode ? "new-password" : "current-password"
  );
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password) {
    showToast("Please enter both email and password.", "warning");
    return;
  }
  const submitBtn = document.getElementById("authSubmitBtn");
  submitBtn.disabled = true;
  try {
    if (signupMode) {
      await createUserWithEmailAndPassword(auth, email, password);
      showToast("Account created! You are now logged in.", "success");
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      showToast("Welcome back to CERS.", "success");
    }
  } catch (err) {
    showToast((signupMode ? "Signup Error: " : "Login Error: ") + err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
}

function logout() {
  signOut(auth)
    .then(() => showToast("Signed out successfully.", "info"))
    .catch((err) => showToast("Logout Error: " + err.message, "error"));
}

// ============ TYPE PILL SELECTION ============
function selectType(btn) {
  document.querySelectorAll(".type-pill").forEach(p => {
    p.classList.remove("active");
    p.setAttribute("aria-checked", "false");
  });
  btn.classList.add("active");
  btn.setAttribute("aria-checked", "true");
  document.getElementById("type").value = btn.dataset.val;
}

// ============ LOCATION AUTOCOMPLETE (SAFE DOM) ============
function setDropdownMessage(text, isError = false) {
  const dd = document.getElementById("locationDropdown");
  dd.replaceChildren();
  const msg = document.createElement("div");
  msg.className = "dd-loading";
  if (isError) msg.style.color = "#f87171";
  msg.textContent = text;
  dd.appendChild(msg);
  dd.classList.remove("hidden");
  document.getElementById("location").setAttribute("aria-expanded", "true");
}

async function handleLocationInput(e) {
  const q = e.target.value.trim();
  if (q.length < 2) { closeDropdown(); return; }

  clearTimeout(ddDebounce);
  ddDebounce = setTimeout(async () => {
    setDropdownMessage("🔍 Searching...");

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`,
        { headers: { "Accept-Language": "en" } }
      );
      const data = await res.json();
      ddItems = Array.isArray(data) ? data : [];
      ddActiveIdx = -1;
      renderDropdown(ddItems);
    } catch {
      setDropdownMessage("Connection error", true);
    }
  }, 300);
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

    const parts = String(place.display_name || "").split(",");
    const main = parts[0].trim();
    const sub = parts.slice(1, 3).join(",").trim();

    const iconSpan = document.createElement("span");
    iconSpan.className = "dd-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.textContent = "📍";

    const textWrap = document.createElement("div");
    const mainDiv = document.createElement("div");
    mainDiv.className = "dd-main";
    mainDiv.textContent = main;
    textWrap.appendChild(mainDiv);

    if (sub) {
      const subDiv = document.createElement("div");
      subDiv.className = "dd-sub";
      subDiv.textContent = sub;
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
  document.getElementById("location").setAttribute("aria-expanded", "true");
}

function handleLocationKey(e) {
  const dd = document.getElementById("locationDropdown");
  if (dd.classList.contains("hidden")) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    ddActiveIdx = Math.min(ddActiveIdx + 1, ddItems.length - 1);
    highlightDropdown();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    ddActiveIdx = Math.max(ddActiveIdx - 1, 0);
    highlightDropdown();
  } else if (e.key === "Enter" && ddActiveIdx >= 0) {
    e.preventDefault();
    selectLocation(ddActiveIdx);
  } else if (e.key === "Escape") {
    closeDropdown();
  }
}

function highlightDropdown() {
  document.querySelectorAll(".dd-item").forEach((el, i) => {
    const active = i === ddActiveIdx;
    el.classList.toggle("active", active);
    el.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function selectLocation(idx) {
  const place = ddItems[idx];
  if (!place) return;
  document.getElementById("location").value = place.display_name;
  closeDropdown();
  showLocationCoords(place.lat, place.lon, place.display_name);
}

function closeDropdown() {
  const dd = document.getElementById("locationDropdown");
  if (dd) {
    dd.classList.add("hidden");
    dd.replaceChildren();
  }
  const locInput = document.getElementById("location");
  if (locInput) locInput.setAttribute("aria-expanded", "false");
  ddItems = [];
  ddActiveIdx = -1;
}

// ============ MAP (SAFE DOM POPUP) ============
function showLocationCoords(lat, lon, label) {
  const mapEl = document.getElementById("map");
  mapEl.classList.remove("hidden");
  if (map) { map.remove(); map = null; }
  const numLat = Number(lat);
  const numLon = Number(lon);
  if (Number.isNaN(numLat) || Number.isNaN(numLon)) return;

  map = L.map("map").setView([numLat, numLon], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap"
  }).addTo(map);

  const popupNode = document.createElement("div");
  popupNode.textContent = `📍 ${label}`;
  L.marker([numLat, numLon]).addTo(map).bindPopup(popupNode).openPopup();
}

function showLocation() {
  const location = document.getElementById("location").value.trim();
  if (!location) {
    showToast("Please enter a location first.", "warning");
    return;
  }
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}`)
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data) || !data.length) {
        showToast("Location not found.", "warning");
        return;
      }
      showLocationCoords(data[0].lat, data[0].lon, location);
    })
    .catch(() => showToast("Map error. Check your internet connection.", "error"));
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
        const maxW = 400;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function previewImage() {
  const file = document.getElementById("image").files[0];
  const preview = document.getElementById("imagePreview");
  const label = document.getElementById("fileLabel");
  if (file) {
    preview.src = URL.createObjectURL(file);
    preview.classList.remove("hidden");
    label.textContent = file.name;
  } else {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
    label.textContent = "Click or drag & drop image here";
  }
}

function handleDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById("image").files = dt.files;
    previewImage();
  } else if (file) {
    showToast("Please drop a valid JPEG, PNG, or WebP image.", "warning");
  }
}

// ============ TIMESTAMP HELPER ============
function getIncidentTimestampMs(incident) {
  if (incident.createdAt && typeof incident.createdAt.toMillis === "function") {
    return incident.createdAt.toMillis();
  }
  if (typeof incident.timestamp === "number") {
    return incident.timestamp;
  }
  return 0;
}

// ============ LOAD FIREBASE (UNSUBSCRIBED CLEANLY) ============
function loadEmergencies() {
  if (unsubscribeEmergencies) {
    unsubscribeEmergencies();
    unsubscribeEmergencies = null;
  }

  const baseCol = collection(db, "emergencies");
  const q = currentUserRole === "citizen" && currentUser
    ? query(baseCol, where("reporterUid", "==", currentUser.uid))
    : baseCol;

  unsubscribeEmergencies = onSnapshot(q, (snapshot) => {
    emergencies = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.archived && currentUserRole !== "admin") return;
      emergencies.push({ id: docSnap.id, ...data });
    });
    emergencies.sort((a, b) => {
      if (a.weight !== b.weight) return a.weight - b.weight;
      return getIncidentTimestampMs(a) - getIncidentTimestampMs(b);
    });
    updateStatusCounts();
    smartRender();
  }, (err) => {
    showToast("Live sync error: " + err.message, "error");
  });
}

// ============ STATUS COUNT BAR ============
function updateStatusCounts() {
  const counts = { Fire: 0, Medical: 0, Accident: 0, Police: 0, Minor: 0 };
  emergencies.forEach(e => { if (counts[e.type] !== undefined) counts[e.type]++; });
  document.getElementById("count-fire").textContent = String(counts.Fire);
  document.getElementById("count-medical").textContent = String(counts.Medical);
  document.getElementById("count-accident").textContent = String(counts.Accident);
  document.getElementById("count-police").textContent = String(counts.Police);
  document.getElementById("count-minor").textContent = String(counts.Minor);
  document.getElementById("count-total").textContent = String(emergencies.length);
}

// ============ PRIORITY ============
function getPriority(type, distance) {
  distance = Number(distance);
  const level = distance < 5 ? "High" : distance <= 10 ? "Medium" : "Low";
  const typePriority = { Fire: 1, Medical: 2, Accident: 3, Police: 4, Minor: 5 };
  return { level, weight: typePriority[type] || 5 };
}

// ============ REPORT EMERGENCY ============
async function reportEmergency(e) {
  if (e && typeof e.preventDefault === "function") e.preventDefault();
  if (!currentUser) {
    showToast("You must be signed in to report an emergency.", "warning");
    return;
  }

  const type = document.getElementById("type").value;
  const location = document.getElementById("location").value.trim();
  const desc = document.getElementById("description").value.trim();
  const distance = document.getElementById("distance").value;
  const file = document.getElementById("image").files[0];

  if (!location || !distance || !desc) {
    showToast("Please fill in location, distance, and description.", "warning");
    return;
  }
  if (Number.isNaN(Number(distance)) || Number(distance) < 0) {
    showToast("Please enter a valid non-negative distance in km.", "warning");
    return;
  }
  if (desc.length < 5) {
    showToast("Description must be at least 5 characters.", "warning");
    return;
  }

  const btn = document.getElementById("submitBtn");
  const btnText = document.getElementById("submitBtnText");
  btnText.textContent = "⏳ Submitting...";
  btn.disabled = true;

  let imgURL = "";
  if (file) {
    try {
      imgURL = await fileToBase64(file);
    } catch (err) {
      showToast(err.message || "Image processing failed.", "error");
      btnText.textContent = "🚨 Submit Emergency Report";
      btn.disabled = false;
      return;
    }
  }

  const priorityData = getPriority(type, distance);

  try {
    await addDoc(collection(db, "emergencies"), {
      uid: currentUser.uid,
      reporterUid: currentUser.uid,
      type,
      location,
      desc,
      distance: Number(distance),
      img: imgURL,
      priority: priorityData.level,
      weight: priorityData.weight,
      status: "Pending",
      archived: false,
      rating: null,
      feedback: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    showToast("Emergency reported successfully!", "success");
    ["location", "description", "distance"].forEach(id => {
      document.getElementById(id).value = "";
    });
    document.getElementById("image").value = "";
    const preview = document.getElementById("imagePreview");
    preview.removeAttribute("src");
    preview.classList.add("hidden");
    document.getElementById("fileLabel").textContent = "Click or drag & drop image here";
    closeDropdown();
  } catch (err) {
    showToast("Error saving report: " + err.message, "error");
  } finally {
    btnText.textContent = "🚨 Submit Emergency Report";
    btn.disabled = false;
  }
}

// ============ FILTER ============
function filterDash(filter, btn) {
  dashFilter = filter;
  document.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  smartRender();
}

// ============ FEEDBACK DOM BUILDER (KEYED BY DOCUMENT ID, PRESERVES INPUT) ============
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
  submitBtn.addEventListener("click", () => submitFeedbackById(incident.id, select.value, textarea.value));

  container.append(labelP, select, textarea, submitBtn);
  return container;
}

async function submitFeedbackById(incidentId, ratingValue, feedbackText) {
  const numericRating = Number(ratingValue);
  if (!numericRating || numericRating < 1 || numericRating > 5) {
    showToast("Please select a star rating (1 to 5) first.", "warning");
    return;
  }
  try {
    await updateDoc(doc(db, "emergencies", incidentId), {
      rating: numericRating,
      feedback: String(feedbackText || "").trim(),
      updatedAt: serverTimestamp()
    });
    showToast("Feedback submitted! Thank you.", "success");
  } catch (err) {
    showToast("Error submitting feedback: " + err.message, "error");
  }
}

// ============ CARD BUILDER (100% SAFE DOM APIS, NO INNERHTML) ============
function createEmergencyCardDOM(e) {
  const tc = TYPE_COLORS[e.type] || { hex: "#555", emoji: "🚨", class: "banner-minor" };
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
    imgEl.alt = `${e.type || "Emergency"} attachment`;
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
  badgeSpan.textContent = e.priority || "Low";

  header.append(typeSpan, badgeSpan);

  const locRow = document.createElement("div");
  locRow.className = "ec-info";
  const locIcon = document.createElement("span");
  locIcon.textContent = "📍";
  const locStrongWrap = document.createElement("span");
  const locStrong = document.createElement("strong");
  locStrong.textContent = e.location || "";
  locStrongWrap.appendChild(locStrong);
  locRow.append(locIcon, locStrongWrap);

  const distRow = document.createElement("div");
  distRow.className = "ec-info";
  const distIcon = document.createElement("span");
  distIcon.textContent = "📏";
  const distText = document.createElement("span");
  const distStrong = document.createElement("strong");
  distStrong.textContent = `${e.distance} km`;
  distText.append(distStrong, document.createTextNode(" from control"));
  distRow.append(distIcon, distText);

  const descP = document.createElement("p");
  descP.className = "ec-desc";
  descP.textContent = e.desc || "";

  const statusDiv = document.createElement("div");
  const isPending = e.status === "Pending" || e.status === "reported";
  statusDiv.className = `status ${isPending ? "status-pending" : "status-resolved"}`;
  const statusIcon = document.createElement("span");
  statusIcon.textContent = isPending ? "🟡" : "✅";
  const statusBold = document.createElement("b");
  statusBold.textContent = e.status || "Pending";
  statusDiv.append(statusIcon, document.createTextNode(" "), statusBold);

  content.append(header, locRow, distRow, descP, statusDiv);

  const actionsContainer = document.createElement("div");
  actionsContainer.className = "card-actions-slot";
  content.appendChild(actionsContainer);

  if (currentUserRole === "admin") {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "deleteBtn";
    deleteBtn.textContent = "🗑️ Archive Report";
    deleteBtn.addEventListener("click", () => deleteEmergency(e.id));
    content.appendChild(deleteBtn);
  }

  card.appendChild(content);
  syncCardDynamicState(card, e);
  return card;
}

// Updates only changed status/feedback fields without wiping active textarea input!
function syncCardDynamicState(card, e) {
  const isPending = e.status === "Pending" || e.status === "reported";
  const isStaff = ["responder", "dispatcher", "admin"].includes(currentUserRole);
  const isOwner = currentUser && (e.reporterUid === currentUser.uid || e.uid === currentUser.uid);

  const statusDiv = card.querySelector(".status");
  if (statusDiv) {
    statusDiv.className = `status ${isPending ? "status-pending" : "status-resolved"}`;
    statusDiv.replaceChildren();
    const statusIcon = document.createElement("span");
    statusIcon.textContent = isPending ? "🟡" : "✅";
    const statusBold = document.createElement("b");
    statusBold.textContent = e.status || "Pending";
    statusDiv.append(statusIcon, document.createTextNode(" "), statusBold);
  }

  const slot = card.querySelector(".card-actions-slot");
  if (!slot) return;

  const existingResolveBtn = slot.querySelector(".resolveBtn");
  const existingFeedbackDiv = slot.querySelector(".feedbackDiv");

  if (isPending) {
    if (existingFeedbackDiv) existingFeedbackDiv.remove();
    if (isStaff && !existingResolveBtn) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "resolveBtn";
      btn.textContent = "✔ Mark as Resolved";
      btn.addEventListener("click", () => resolve(e.id));
      slot.appendChild(btn);
    } else if (!isStaff && existingResolveBtn) {
      existingResolveBtn.remove();
    }
  } else {
    if (existingResolveBtn) existingResolveBtn.remove();
    if (isOwner || isStaff) {
      const nowRated = e.rating ? "true" : "false";
      if (!existingFeedbackDiv) {
        slot.appendChild(buildFeedbackSection(e));
      } else if (existingFeedbackDiv.dataset.rated !== nowRated || nowRated === "true") {
        // Only replace feedback section if it transitioned to rated;
        // if still unrated ("false"), preserve user's in-progress select/textarea!
        existingFeedbackDiv.replaceWith(buildFeedbackSection(e));
      }
    }
  }
}

// ============ SMART RENDER ============
function smartRender() {
  const grid = document.getElementById("emergencyGrid");
  if (!grid) return;

  const filtered = dashFilter === "all"
    ? emergencies
    : emergencies.filter(e => e.status === dashFilter);

  Array.from(grid.querySelectorAll(".emergency-card")).forEach(card => {
    if (!emergencies.find(e => e.id === card.dataset.id)) card.remove();
  });

  const existingEmptyMsg = grid.querySelector(".empty-state-msg");

  if (filtered.length === 0) {
    Array.from(grid.querySelectorAll(".emergency-card")).forEach(card => {
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

  if (existingEmptyMsg) existingEmptyMsg.remove();

  Array.from(grid.querySelectorAll(".emergency-card")).forEach(card => {
    const show = dashFilter === "all" || emergencies.some(e => e.id === card.dataset.id && e.status === dashFilter);
    card.style.display = show ? "" : "none";
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

// ============ RESOLVE ============
async function resolve(id) {
  if (!["responder", "dispatcher", "admin"].includes(currentUserRole)) {
    showToast("Only authorized responders, dispatchers, or admins can resolve incidents.", "warning");
    return;
  }
  try {
    await updateDoc(doc(db, "emergencies", id), {
      status: "Resolved",
      resolvedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showToast("Incident marked as resolved.", "success");
  } catch (err) {
    showToast("Error resolving incident: " + err.message, "error");
  }
}

// ============ SOFT DELETE / ARCHIVE (ADMIN ONLY) ============
async function deleteEmergency(id) {
  if (currentUserRole !== "admin") {
    showToast("Only administrators can archive emergency reports.", "warning");
    return;
  }
  const confirmed = await showConfirmModal(
    "Archive Emergency Report",
    "Are you sure you want to archive this incident? It will be hidden from active views and logged in the audit trail."
  );
  if (!confirmed) return;

  try {
    await updateDoc(doc(db, "emergencies", id), {
      archived: true,
      updatedAt: serverTimestamp()
    });
    await addDoc(collection(db, "auditLogs"), {
      incidentId: id,
      actorUid: currentUser.uid,
      actorRole: currentUserRole,
      action: "archived",
      createdAt: serverTimestamp()
    });
    showToast("Incident archived and recorded in audit log.", "info");
  } catch (err) {
    showToast("Error archiving incident: " + err.message, "error");
  }
}

// ============ NOTIFICATIONS (SAFE DOM) ============
function updateNotifications() {
  const panel = document.getElementById("notifications");
  if (!panel) return;
  panel.replaceChildren();

  if (emergencies.length === 0) {
    const emptyP = document.createElement("p");
    emptyP.style.cssText = "color:#64748b;font-size:13px";
    emptyP.textContent = "No recent emergencies.";
    panel.appendChild(emptyP);
    return;
  }

  const recent = [...emergencies].sort((a, b) => getIncidentTimestampMs(b) - getIncidentTimestampMs(a));
  recent.slice(0, 5).forEach(e => {
    const tc = TYPE_COLORS[e.type] || {};
    const div = document.createElement("div");
    div.className = `notification notif-${String(e.type || "minor").toLowerCase()} notif-default`;

    const wrap = document.createElement("div");
    const titleLine = document.createElement("div");
    const emojiText = document.createTextNode(`${tc.emoji || "🚨"} `);
    const strongType = document.createElement("strong");
    strongType.textContent = e.type || "Incident";
    const locText = document.createTextNode(` at ${e.location || ""}`);
    titleLine.append(emojiText, strongType, locText);

    const timeLine = document.createElement("div");
    timeLine.className = "notif-time";
    timeLine.textContent = `${e.priority || "Low"} Priority · ${timeAgo(getIncidentTimestampMs(e))}`;

    wrap.append(titleLine, timeLine);
    div.appendChild(wrap);
    panel.appendChild(div);
  });
}

function timeAgo(ts) {
  if (!ts) return "just now";
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ============ LANGUAGE ============
function toggleLanguage() {
  lang = lang === "en" ? "hi" : "en";
  const texts = {
    en: { title: "City Emergency Response", reportTitle: "Report Emergency",
          dashboardTitle: "⚡ Emergency Dashboard", notifTitle: "Live Feed" },
    hi: { title: "शहर आपातकालीन प्रणाली", reportTitle: "आपातकाल रिपोर्ट करें",
          dashboardTitle: "⚡ आपातकाल डैशबोर्ड", notifTitle: "नवीनतम घटनाएँ" }
  };
  const t = texts[lang];
  document.getElementById("title").textContent = t.title;
  document.getElementById("reportTitleText").textContent = t.reportTitle;
  document.getElementById("dashboardTitle").textContent = t.dashboardTitle;
  document.getElementById("notifTitleText").textContent = t.notifTitle;
}

// ============ WIRE EVENT LISTENERS ============
function initEventListeners() {
  document.getElementById("authForm")?.addEventListener("submit", handleAuthSubmit);
  document.getElementById("toggleAuthBtn")?.addEventListener("click", toggleAuth);
  document.getElementById("langToggleBtn")?.addEventListener("click", toggleLanguage);
  document.getElementById("logoutBtn")?.addEventListener("click", logout);

  document.querySelectorAll(".type-pill").forEach((pill) => {
    pill.addEventListener("click", () => selectType(pill));
  });

  const locInput = document.getElementById("location");
  locInput?.addEventListener("input", handleLocationInput);
  locInput?.addEventListener("keydown", handleLocationKey);

  document.getElementById("showMapBtn")?.addEventListener("click", showLocation);

  const fileDrop = document.getElementById("fileDrop");
  const fileInput = document.getElementById("image");
  fileDrop?.addEventListener("click", () => fileInput?.click());
  fileDrop?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput?.click();
    }
  });
  fileDrop?.addEventListener("dragover", (e) => e.preventDefault());
  fileDrop?.addEventListener("drop", handleDrop);
  fileInput?.addEventListener("change", previewImage);

  document.getElementById("reportForm")?.addEventListener("submit", reportEmergency);

  document.querySelectorAll(".filter-pill").forEach((btn) => {
    btn.addEventListener("click", () => filterDash(btn.dataset.filter || "all", btn));
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".location-wrapper")) closeDropdown();
  });
}

initEventListeners();
