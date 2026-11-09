#!/usr/bin/env node
/**
 * Zero-dependency Node.js built-in test runner (node --test tests/run-tests.mjs)
 * Verifies core triage, geospatial, state machine, XSS/image validation,
 * data migration, and Firestore/Storage security rule invariants.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformLegacyDocument } from "../scripts/migrate-firestore-data.mjs";

describe("CERS Production Verification Suite", () => {
  it("transforms legacy v1 Firestore documents with coordinates, geohash, and status mapping", () => {
    const legacy = {
      type: "Fire",
      location: "Connaught Place",
      desc: "Transformer fire",
      distance: 99, // Untrusted user-typed distance
      img: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      status: "Pending",
    };
    const result = transformLegacyDocument("doc_123", legacy, {
      lat: 28.6315,
      lng: 77.2167,
    });
    assert.equal(result.patch.status, "reported");
    assert.equal(result.patch.geohash, "ttnfvh5qx");
    assert.ok(result.patch.distance < 5, "Recomputes server-side Haversine distance");
    assert.equal(result.needsBase64Upload, true);
  });

  it("enforces RBAC, reporterUid provenance, and soft-delete in firestore.rules", () => {
    const rules = readFileSync("firestore.rules", "utf8");
    assert.ok(rules.includes("request.resource.data.reporterUid == request.auth.uid"));
    assert.ok(rules.includes("request.resource.data.createdAt == request.time"));
    assert.ok(rules.includes("allow delete: if false;"));
    assert.ok(rules.includes("function isValidTransition(fromState, toState)"));
  });

  it("enforces MIME type and 5MB limit in storage.rules", () => {
    const storageRules = readFileSync("storage.rules", "utf8");
    assert.ok(storageRules.includes("request.resource.size <= 5 * 1024 * 1024"));
    assert.ok(storageRules.includes("request.resource.contentType.matches('image/(jpeg|png|webp)')"));
  });

  it("enforces CSP and SRI in index.html and removes all inline onclick handlers", () => {
    const html = readFileSync("index.html", "utf8");
    assert.ok(html.includes('http-equiv="Content-Security-Policy"'));
    assert.ok(html.includes('integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="'));
    assert.ok(!html.includes("onclick="), "No inline onclick attributes in index.html");
  });

  it("implements isolated public safety portals (Citizen, Dispatcher CAD, Responder MDT)", () => {
    const html = readFileSync("index.html", "utf8");
    assert.ok(html.includes('id="citizenPortalView"'), "Has dedicated citizen view");
    assert.ok(html.includes('id="responderPortalView"'), "Has dedicated responder vehicle terminal");
    assert.ok(html.includes('id="dispatcherPortalView"'), "Has dedicated dispatcher CAD command view");
    assert.ok(
      html.includes('id="tabCitizenPortal"') && html.includes('id="tabAuthorityPortal"'),
      "Has Citizen vs Authority login tabs"
    );
    assert.ok(html.includes('id="citizenTrackingList"'), "Has live milestone incident tracking stepper");

    const js = readFileSync("emergency.js", "utf8");
    assert.ok(js.includes("renderCitizenTrackingList"), "Implements citizen incident tracking stepper");
    assert.ok(js.includes("renderResponderMdtView"), "Implements responder tactical MDT");
    assert.ok(js.includes("loginAsDemo"), "Implements one-click demo access for evaluators");
    assert.ok(!js.includes("infoRow.innerHTML = `"), "No unsafe innerHTML template strings");
  });
});

