import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

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
let map;
let listenerActive = false;
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

// ============ AUTH STATE ============
onAuthStateChanged(auth, (user) => {
  if (user) {
    document.getElementById("authPage").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    if (!listenerActive) { loadEmergencies(); listenerActive = true; }
  } else {
    document.getElementById("authPage").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
    listenerActive = false;
  }
});

// ============ AUTH TOGGLE ============
function toggleAuth() {
  signupMode = !signupMode;
  document.getElementById("authTitle").innerText = signupMode ? "Signup" : "Login";
  document.querySelector(".submit").innerText = signupMode ? "Create Account →" : "Login →";
  document.getElementById("switchText").innerText = signupMode ? "Have account?" : "No account?";
}

// ============ LOGIN / SIGNUP ============
function login() {
  const email = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password) { alert("Please enter email and password."); return; }
  if (signupMode) {
    createUserWithEmailAndPassword(auth, email, password)
      .then(() => alert("Account created! You are now logged in."))
      .catch((err) => alert("Signup Error: " + err.message));
  } else {
    signInWithEmailAndPassword(auth, email, password)
      .catch((err) => alert("Login Error: " + err.message));
  }
}

// ============ TYPE PILL SELECTION ============
function selectType(btn) {
  document.querySelectorAll(".type-pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("type").value = btn.dataset.val;
}

// ============ LOCATION AUTOCOMPLETE ============
async function handleLocationInput(e) {
  const q = e.target.value.trim();
  const dd = document.getElementById("locationDropdown");

  if (q.length < 2) { closeDropdown(); return; }

  clearTimeout(ddDebounce);
  ddDebounce = setTimeout(async () => {
    dd.innerHTML = `<div class="dd-loading">🔍 Searching...</div>`;
    dd.classList.remove("hidden");

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`,
        { headers: { "Accept-Language": "en" } }
      );
      const data = await res.json();
      ddItems = data;
      ddActiveIdx = -1;
      renderDropdown(data);
    } catch {
      dd.innerHTML = `<div class="dd-loading" style="color:#f87171">Connection error</div>`;
    }
  }, 280);
}

function renderDropdown(results) {
  const dd = document.getElementById("locationDropdown");
  if (!results.length) {
    dd.innerHTML = `<div class="dd-loading">No places found</div>`;
    return;
  }
  dd.innerHTML = "";
  results.forEach((place, idx) => {
    const div = document.createElement("div");
    div.className = "dd-item";
    div.dataset.idx = idx;

    const parts = place.display_name.split(",");
    const main = parts[0].trim();
    const sub = parts.slice(1, 3).join(",").trim();

    div.innerHTML = `
      <span class="dd-icon">📍</span>
      <div>
        <div class="dd-main">${main}</div>
        ${sub ? `<div class="dd-sub">${sub}</div>` : ""}
      </div>`;

    div.addEventListener("mousedown", (e) => {
      e.preventDefault(); // prevent blur before click
      selectLocation(idx);
    });
    dd.appendChild(div);
  });
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
    el.classList.toggle("active", i === ddActiveIdx);
  });
}

function selectLocation(idx) {
  const place = ddItems[idx];
  document.getElementById("location").value = place.display_name;
  closeDropdown();
  // auto-show map
  showLocationCoords(place.lat, place.lon, place.display_name);
}

function closeDropdown() {
  document.getElementById("locationDropdown").classList.add("hidden");
  ddItems = []; ddActiveIdx = -1;
}

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".location-wrapper")) closeDropdown();
});

// ============ MAP ============
function showLocationCoords(lat, lon, label) {
  const mapEl = document.getElementById("map");
  mapEl.style.display = "block";
  if (map) { map.remove(); map = null; }
  map = L.map("map").setView([lat, lon], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap"
  }).addTo(map);
  L.marker([lat, lon]).addTo(map).bindPopup(`📍 ${label}`).openPopup();
}

function showLocation() {
  const location = document.getElementById("location").value.trim();
  if (!location) { alert("Please enter a location first."); return; }
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}`)
    .then(r => r.json())
    .then(data => {
      if (!data.length) { alert("Location not found."); return; }
      showLocationCoords(data[0].lat, data[0].lon, location);
    })
    .catch(() => alert("Map error. Check your internet."));
}

// ============ IMAGE HANDLING ============
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
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
    preview.style.display = "block";
    label.textContent = file.name;
  } else {
    preview.style.display = "none";
    label.textContent = "Click or drag & drop image here";
  }
}

function handleDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) {
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById("image").files = dt.files;
    previewImage();
  }
}

// ============ LOAD FIREBASE ============
function loadEmergencies() {
  onSnapshot(collection(db, "emergencies"), (snapshot) => {
    emergencies = [];
    snapshot.forEach((docSnap) => {
      emergencies.push({ id: docSnap.id, ...docSnap.data() });
    });
    emergencies.sort((a, b) => {
      if (a.weight !== b.weight) return a.weight - b.weight;
      return a.timestamp - b.timestamp;
    });
    updateStatusCounts();
    smartRender();
  });
}

// ============ STATUS COUNT BAR ============
function updateStatusCounts() {
  const counts = { Fire: 0, Medical: 0, Accident: 0, Police: 0 };
  emergencies.forEach(e => { if (counts[e.type] !== undefined) counts[e.type]++; });
  document.getElementById("count-fire").textContent = counts.Fire;
  document.getElementById("count-medical").textContent = counts.Medical;
  document.getElementById("count-accident").textContent = counts.Accident;
  document.getElementById("count-police").textContent = counts.Police;
  document.getElementById("count-total").textContent = emergencies.length;
}

// ============ PRIORITY ============
function getPriority(type, distance) {
  distance = Number(distance);
  const level = distance < 5 ? "High" : distance <= 10 ? "Medium" : "Low";
  const typePriority = { Fire: 1, Medical: 2, Accident: 3, Police: 4, Minor: 5 };
  return { level, weight: typePriority[type] || 5 };
}

// ============ REPORT EMERGENCY ============
async function reportEmergency() {
  const type = document.getElementById("type").value;
  const location = document.getElementById("location").value.trim();
  const desc = document.getElementById("description").value.trim();
  const distance = document.getElementById("distance").value;
  const file = document.getElementById("image").files[0];

  if (!location || !distance || !desc) { alert("Please fill all fields."); return; }

  const btn = document.getElementById("submitBtn");
  btn.innerHTML = "<span>⏳ Submitting...</span>";
  btn.disabled = true;

  let imgURL = "";
  if (file) {
    try { imgURL = await fileToBase64(file); }
    catch (err) { console.warn("Image conversion failed:", err); }
  }

  const priorityData = getPriority(type, distance);

  try {
    await addDoc(collection(db, "emergencies"), {
      type, location, desc,
      distance: Number(distance),
      img: imgURL,
      priority: priorityData.level,
      weight: priorityData.weight,
      status: "Pending",
      rating: null,
      feedback: "",
      timestamp: Date.now()
    });

    alert("✅ Emergency reported successfully!");
    ["location","description","distance"].forEach(id => document.getElementById(id).value = "");
    document.getElementById("image").value = "";
    document.getElementById("imagePreview").style.display = "none";
    document.getElementById("fileLabel").textContent = "Click or drag & drop image here";
    closeDropdown();
  } catch (err) {
    alert("❌ Error saving: " + err.message);
  } finally {
    btn.innerHTML = "<span>🚨 Submit Emergency Report</span><span class='btn-arrow'>→</span>";
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

// ============ SMART RENDER ============
function smartRender() {
  const grid = document.getElementById("emergencyGrid");

  const filtered = dashFilter === "all"
    ? emergencies
    : emergencies.filter(e => e.status === dashFilter);

  if (filtered.length === 0) {
    grid.innerHTML = "<p style='color:#64748b;padding:20px;font-size:14px'>No emergencies match this filter.</p>";
    updateNotifications();
    return;
  }

  // Remove deleted cards
  Array.from(grid.querySelectorAll(".emergency-card")).forEach(card => {
    if (!emergencies.find(e => e.id === card.dataset.id)) grid.removeChild(card);
  });

  // Hide cards not in filter, show those that are
  Array.from(grid.querySelectorAll(".emergency-card")).forEach(card => {
    const show = dashFilter === "all" || emergencies.find(e => e.id === card.dataset.id && e.status === dashFilter);
    card.style.display = show ? "" : "none";
  });

  filtered.forEach((e, i) => {
    let existingCard = grid.querySelector(`[data-id="${e.id}"]`);

    if (existingCard) {
      existingCard.style.display = "";
      const statusDiv = existingCard.querySelector(".status");
      if (statusDiv) {
        statusDiv.className = "status " + (e.status === "Pending" ? "status-pending" : "status-resolved");
        statusDiv.innerHTML = e.status === "Pending"
          ? `<span>🟡</span> <b>Pending</b>`
          : `<span>✅</span> <b>Resolved</b>`;
      }
      const resolveBtn = existingCard.querySelector(".resolveBtn");
      const feedbackDiv = existingCard.querySelector(".feedbackDiv");

      if (e.status === "Pending") {
        if (!resolveBtn) {
          if (feedbackDiv) feedbackDiv.remove();
          const btn = document.createElement("button");
          btn.className = "resolveBtn";
          btn.innerText = "✔ Mark as Resolved";
          btn.onclick = () => window.resolve(e.id);
          existingCard.querySelector(".emergency-content").insertBefore(
            btn, existingCard.querySelector(".deleteBtn")
          );
        }
      } else {
        if (resolveBtn) resolveBtn.remove();
        if (!feedbackDiv) {
          const fb = document.createElement("div");
          fb.className = "feedbackDiv";
          fb.innerHTML = feedbackHTML(emergencies.indexOf(e));
          existingCard.querySelector(".emergency-content").insertBefore(
            fb, existingCard.querySelector(".deleteBtn")
          );
        } else {
          feedbackDiv.innerHTML = feedbackHTML(emergencies.indexOf(e));
        }
      }
    } else {
      // Create new card
      const tc = TYPE_COLORS[e.type] || { hex: "#555", emoji: "🚨", class: "banner-minor" };
      const badgeClass = (e.priority || "low").toLowerCase();
      const card = document.createElement("div");
      card.className = "emergency-card";
      card.dataset.id = e.id;

      const imageSection = e.img && e.img.startsWith("data:")
        ? `<img src="${e.img}" alt="${e.type}">`
        : `<div class="type-banner-placeholder" style="background: linear-gradient(135deg, ${tc.hex}22, ${tc.hex}44);">
             <span style="font-size:2.5rem">${tc.emoji}</span>
             <span style="font-family:var(--font-head);font-size:1.1rem;font-weight:700;color:${tc.hex};letter-spacing:2px">${e.type.toUpperCase()}</span>
           </div>`;

      const statusClass = e.status === "Pending" ? "status-pending" : "status-resolved";
      const statusIcon = e.status === "Pending" ? "🟡" : "✅";
      const globalIdx = emergencies.indexOf(e);

      card.innerHTML = `
        <div class="card-type-banner ${tc.class}"></div>
        ${imageSection}
        <div class="emergency-content">
          <div class="ec-header">
            <span class="ec-type" style="color:${tc.hex}">${tc.emoji} ${e.type}</span>
            <span class="badge ${badgeClass}">${e.priority}</span>
          </div>
          <div class="ec-info"><span>📍</span><span><strong>${e.location}</strong></span></div>
          <div class="ec-info"><span>📏</span><span><strong>${e.distance} km</strong> from control</span></div>
          <p class="ec-desc">${e.desc}</p>
          <div class="status ${statusClass}">${statusIcon} <b>${e.status}</b></div>
          ${e.status === "Pending"
            ? `<button class="resolveBtn" onclick="window.resolve('${e.id}')">✔ Mark as Resolved</button>`
            : `<div class="feedbackDiv">${feedbackHTML(globalIdx)}</div>`}
          <button class="deleteBtn" onclick="window.deleteEmergency('${e.id}')">🗑️ Delete Report</button>
        </div>`;
      grid.appendChild(card);
    }
  });

  updateNotifications();
}

// ============ RESOLVE ============
async function resolve(id) {
  try {
    await updateDoc(doc(db, "emergencies", id), { status: "Resolved" });
  } catch (err) { alert("Error resolving: " + err.message); }
}

// ============ DELETE ============
async function deleteEmergency(id) {
  if (!confirm("Delete this emergency report?")) return;
  try {
    await deleteDoc(doc(db, "emergencies", id));
  } catch (err) { alert("Error deleting: " + err.message); }
}

// ============ FEEDBACK ============
function feedbackHTML(i) {
  const e = emergencies[i];
  if (!e) return "";
  if (e.rating) {
    return `<p>⭐ Rating: <strong>${e.rating}/5</strong></p>
      <p style="margin-top:4px;color:#94a3b8;font-size:12px">${e.feedback || "No feedback given"}</p>`;
  }
  return `<p style="font-weight:600;margin-bottom:6px">Rate the response:</p>
    <select onchange="window.setRating(${i}, this.value)">
      <option value="">Select rating</option>
      <option value="1">1 ⭐</option><option value="2">2 ⭐⭐</option>
      <option value="3">3 ⭐⭐⭐</option><option value="4">4 ⭐⭐⭐⭐</option>
      <option value="5">5 ⭐⭐⭐⭐⭐</option>
    </select>
    <textarea id="feedback${i}" placeholder="Write feedback..." rows="2" style="margin-top:6px"></textarea>
    <button onclick="window.submitFeedback(${i})">Submit Feedback</button>`;
}

function setRating(i, val) { if (emergencies[i]) emergencies[i].rating = val; }

async function submitFeedback(i) {
  const text = document.getElementById("feedback" + i)?.value || "";
  if (!emergencies[i]?.rating) { alert("Please select a rating first."); return; }
  try {
    await updateDoc(doc(db, "emergencies", emergencies[i].id), {
      feedback: text, rating: emergencies[i].rating
    });
    alert("✅ Feedback submitted!");
  } catch (err) { alert("Error: " + err.message); }
}

// ============ NOTIFICATIONS ============
function updateNotifications() {
  const panel = document.getElementById("notifications");
  panel.innerHTML = "";
  if (emergencies.length === 0) {
    panel.innerHTML = "<p style='color:#64748b;font-size:13px'>No recent emergencies.</p>";
    return;
  }
  emergencies.slice(0, 5).forEach(e => {
    const tc = TYPE_COLORS[e.type] || {};
    const div = document.createElement("div");
    div.className = `notification notif-${e.type.toLowerCase()} notif-default`;
    const ago = timeAgo(e.timestamp);
    div.innerHTML = `
      <div>
        <div>${tc.emoji || "🚨"} <strong>${e.type}</strong> at ${e.location}</div>
        <div class="notif-time">${e.priority} Priority · ${ago}</div>
      </div>`;
    panel.appendChild(div);
  });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ============ LANGUAGE ============
function toggleLanguage() {
  lang = lang === "en" ? "hi" : "en";
  const texts = {
    en: { title: "City Emergency Response", reportTitle: "📡 Report Emergency",
          dashboardTitle: "⚡ Emergency Dashboard", notifTitle: "📻 Live Feed" },
    hi: { title: "शहर आपातकालीन प्रणाली", reportTitle: "📡 आपातकाल रिपोर्ट करें",
          dashboardTitle: "⚡ आपातकाल डैशबोर्ड", notifTitle: "📻 नवीनतम घटनाएँ" }
  };
  const t = texts[lang];
  document.getElementById("title").innerText = t.title;
  document.getElementById("title").innerText = t.title;
  document.getElementById("reportTitle").innerHTML = `<span class="header-icon"></span>${t.reportTitle}`;
  document.getElementById("dashboardTitle").innerText = t.dashboardTitle;
  document.getElementById("notifTitle").innerHTML = `<span class="header-icon"></span>${t.notifTitle}`;
}

// ============ EXPOSE GLOBALLY ============
window.toggleAuth = toggleAuth;
window.login = login;
window.selectType = selectType;
window.reportEmergency = reportEmergency;
window.resolve = resolve;
window.setRating = setRating;
window.submitFeedback = submitFeedback;
window.toggleLanguage = toggleLanguage;
window.showLocation = showLocation;
window.previewImage = previewImage;
window.handleDrop = handleDrop;
window.deleteEmergency = deleteEmergency;
window.filterDash = filterDash;
window.handleLocationInput = handleLocationInput;
window.handleLocationKey = handleLocationKey;
  