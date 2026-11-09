# Changelog

All notable changes to the **City Emergency Response System (CERS)** are documented in this file.

## [2.0.0] — 2026-11-09

### Security
- Added [`firestore.rules`](./firestore.rules) and [`storage.rules`](./storage.rules) enforcing 4-tier RBAC (`citizen`, `responder`, `dispatcher`, `admin`) via Firebase Auth custom claims.
- Added `reporterUid`, `uid`, and `createdAt: serverTimestamp()` provenance checks on all incident creations.
- Replaced hard deletes with admin-only soft-delete (`archived: true`) and an immutable append-only `auditLogs` collection (`allow update, delete: if false;`).
- Eliminated all `innerHTML` user-data interpolation and inline `onclick` handlers; added strict `isValidImageSrc` validation, Content-Security-Policy (CSP), and Subresource Integrity (SRI) hashes.
- Added Firebase App Check support, per-user report rate limiting, email verification on signup, password reset, and GDPR/DPDP account & data deletion.

### Added
- **Core Dispatch Engine:** `units` collection, Responder portal, nearest-available-unit recommendation (Haversine distance + urban ETA + capability match), duplicate nearby incident detection & merging, and incident timeline modal.
- **Incident Lifecycle State Machine:** `reported -> verified -> assigned -> en_route -> on_scene -> resolved -> closed` (plus `false_alarm` and `cancelled`) enforced in UI, Firestore rules, and Cloud Functions.
- **Cloud Functions v2 (`functions/`):** Authoritative server-side Haversine distance & priority triage scoring (`onIncidentCreated`), validated state transitions (`transitionIncidentState`), admin custom claims manager (`setUserRole`), rate-limited geocoding proxy (`geocodeProxy`), and 5-minute scheduled SLA auto-escalation (`escalateUnassignedIncidents`).
- **Citizen Experience:** Geolocation API ("Use My Location") + draggable Leaflet pin, one-tap official emergency helpline banner (`112`, `100`, `101`, `108`), live status notifications, and PWA offline report queue (`src/db/offlineQueue.ts` + `public/sw.js`).
- **Dispatcher Analytics & Clustered GIS Map:** Live clustered map of active incidents and fleet units, search/sort/pagination controls, formula-safe CSV export, and SLA analytics dashboard.
- **Full i18n & Accessibility (WCAG 2.1 AA):** Complete English (`en.json`) and Hindi (`hi.json`) translation dictionaries with `Intl` formatting, semantic labels, ARIA live toasts/dialogs, and a Reduced Motion toggle that disables scanlines and pulse animations.
- **Engineering & CI/CD:** Migrated to Vite + strict TypeScript (`/src/{auth,db,map,ui,i18n,services,utils,types}`), added Vitest unit/rules tests, Playwright E2E tests, Firestore v1-to-v2 data migration script (`scripts/migrate-firestore-data.mjs`), and GitHub Actions CI/CD (`.github/workflows/ci-cd.yml`).
