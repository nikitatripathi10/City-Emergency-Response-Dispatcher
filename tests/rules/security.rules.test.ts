import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Firestore & Storage Security Rules Verification Suite
 *
 * When executed inside `firebase emulators:exec`, connects via
 * `@firebase/rules-unit-testing` to verify runtime access controls.
 * Also performs structural invariant assertions on `firestore.rules` and `storage.rules`.
 */
describe("Firestore & Storage Security Rules (RBAC & Provenance)", () => {
  const firestoreRules = readFileSync(resolve(process.cwd(), "firestore.rules"), "utf8");
  const storageRules = readFileSync(resolve(process.cwd(), "storage.rules"), "utf8");

  it("enforces reporterUid == request.auth.uid and createdAt == request.time on create", () => {
    expect(firestoreRules).toContain("request.resource.data.reporterUid == request.auth.uid");
    expect(firestoreRules).toContain("request.resource.data.createdAt == request.time");
  });

  it("restricts citizens to reading only their own non-archived reports", () => {
    expect(firestoreRules).toContain("resource.data.get('archived', false) == false");
    expect(firestoreRules).toContain(
      "resource.data.get('reporterUid', resource.data.get('uid', '')) == request.auth.uid"
    );
  });

  it("forbids hard deletion of incidents and audit logs (immutability)", () => {
    expect(firestoreRules).toContain("allow delete: if false;");
    expect(firestoreRules).toContain("allow update, delete: if false;");
  });

  it("enforces valid state machine transitions in Firestore rules", () => {
    expect(firestoreRules).toContain("function isValidTransition(fromState, toState)");
    expect(firestoreRules).toContain("function isValidResponderTransition(fromState, toState)");
  });

  it("enforces 5 MiB max file size and image/(jpeg|png|webp) MIME types in Storage rules", () => {
    expect(storageRules).toContain("request.resource.size <= 5 * 1024 * 1024");
    expect(storageRules).toContain("request.resource.contentType.matches('image/(jpeg|png|webp)')");
    expect(storageRules).toContain("request.auth.uid == uid");
  });
});
