# Security Policy

## Architecture & Security Controls

1. **Role-Based Access Control (RBAC):**
   - Enforced in [`firestore.rules`](./firestore.rules), [`storage.rules`](./storage.rules), and Cloud Functions ([`functions/src/index.ts`](./functions/src/index.ts)) via Firebase Authentication custom claims (`citizen`, `responder`, `dispatcher`, `admin`).
   - Citizens can only read their own reports (`reporterUid == request.auth.uid`), can only cancel their own unassigned reports, and can only submit a 1–5 star rating after their report is resolved.
   - Hard deletion of incidents and audit logs is forbidden (`allow delete: if false;`). Only `admin` accounts can soft-delete (`archived: true`).
2. **XSS & Injection Prevention:**
   - All dynamic UI rendering uses safe DOM APIs (`document.createElement`, `textContent`).
   - Strict Content-Security-Policy (CSP) and Subresource Integrity (SRI) hashes protect third-party assets.
   - CSV exports neutralize spreadsheet formula injection (`=`, `+`, `-`, `@`).
3. **Media Upload Validation:**
   - Enforced both client-side and in `storage.rules`: only `image/jpeg`, `image/png`, and `image/webp` up to `5 MiB` under `/incident-media/{uid}/{incidentId}/{fileName}`.
4. **API Key & Abuse Protection:**
   - Firebase App Check (reCAPTCHA Enterprise) guards Firestore, Storage, and Functions.
   - Geocoding API keys (`MAPBOX_ACCESS_TOKEN`, `GOOGLE_MAPS_API_KEY`) stay exclusively in Cloud Functions behind `/api/geocode` with per-IP rate limiting.

## Reporting a Vulnerability

If you discover a security vulnerability, please open a private security advisory on GitHub (`https://github.com/nikitatripathi10/City-Emergency-Response-Dispatcher/security/advisories`) rather than a public issue.
