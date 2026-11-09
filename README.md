# 🚨 City Emergency Response System (CERS)

A real-time emergency reporting and dispatch dashboard that connects citizens and control-room operators on a single live platform. Built with **Firebase Authentication**, **Cloud Firestore**, **Leaflet.js**, and **OpenStreetMap Nominatim** for instant incident synchronization, interactive mapping, and automated priority triage.

---

## 📌 Overview

During an emergency, delays in reporting and coordination cost critical time. **CERS** enables users to report incidents in seconds with location autocomplete and photo attachments, automatically calculates priority levels based on emergency category and distance from the control room, and streams live updates to the operations dashboard without manual refreshes.

## ✨ Key Features

- **Real-Time Incident Reporting & Sync:** Powered by Cloud Firestore `onSnapshot` listeners so new reports, status changes, and deletions appear instantaneously across all connected clients.
- **Automated Priority Triage:** Calculates urgency level (`High` < 5 km, `Medium` ≤ 10 km, `Low` > 10 km) and sorts incidents by severity weight (`Fire` → `Medical` → `Accident` → `Police` → `Minor`) and timestamp.
- **Interactive Map & Location Autocomplete:** Uses the **OpenStreetMap Nominatim API** with debounced search and keyboard navigation, paired with **Leaflet.js** map pins and popups.
- **Client-Side Image Compression:** Drag-and-drop photo uploader that resizes and compresses images via HTML5 `<canvas>` (max width `400px`, JPEG `0.7` quality) for fast real-time storage.
- **Live Operations Dashboard & Feed:** Category counter chips (`Fire`, `Medical`, `Accident`, `Police`, `Minor`, `Total`), status filtering (`All`, `Pending`, `Resolved`), a real-time **Live Feed** of the 5 most recent incidents, and post-resolution 1–5 star rating & feedback.
- **Bilingual Interface (EN / हिंदी):** Instant one-click language toggle between English and Hindi.
- **Firebase Authentication:** Email & password login, signup, and session management.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | HTML5, CSS3 (Custom Cyber/Operations UI), Vanilla JavaScript (ES6 Modules) |
| **Database** | Firebase Cloud Firestore (Real-time `onSnapshot` sync) |
| **Authentication** | Firebase Authentication (Email / Password) |
| **Maps & Geocoding** | Leaflet.js `1.9.4` + OpenStreetMap Nominatim API |
| **Typography** | Google Fonts (`Rajdhani` & `Exo 2`) |

---

## 📊 Priority & Triage Matrix

Incidents are automatically prioritized using two factors:

1. **Category Weight** (determines dashboard sort order):
   - 🔥 **Fire** (`Weight 1`)
   - 🏥 **Medical** (`Weight 2`)
   - 🚗 **Accident** (`Weight 3`)
   - 🚔 **Police** (`Weight 4`)
   - ⚠️ **Minor** (`Weight 5`)

2. **Distance from Control Room (km)** (determines severity badge):
   - **High Priority:** `< 5 km`
   - **Medium Priority:** `5 – 10 km`
   - **Low Priority:** `> 10 km`

---

## 📁 Project Structure

```text
City-Emergency-Response-Dispatcher/
├── index.html          # Auth screen, emergency report form, live feed & dashboard layout
├── emergency.js        # Firebase Auth/Firestore logic, Nominatim geocoding, Leaflet map & DOM rendering
├── style.css           # Dark operations theme, scanline overlay, pulse animations & responsive grid
├── package.json        # Project dependencies metadata
├── package-lock.json   # Locked dependency tree
└── README.md           # Project documentation
```

---

## 🚀 Getting Started

### Prerequisites

- A modern web browser
- A local HTTP server (because [`emergency.js`](./emergency.js) is loaded as an ES module via `<script type="module">`)

### Installation & Running Locally

1. **Clone the repository**
   ```bash
   git clone https://github.com/nikitatripathi10/City-Emergency-Response-Dispatcher.git
   cd City-Emergency-Response-Dispatcher
   ```

2. **Serve the application over HTTP**
   ```bash
   npx serve .
   # or using Python:
   python -m http.server 8000
   ```

3. **Open in browser**
   Navigate to `http://localhost:8000` (or the port shown in your terminal).

---

## 👤 Author

**Nikita Tripathi** ([@nikitatripathi10](https://github.com/nikitatripathi10))
