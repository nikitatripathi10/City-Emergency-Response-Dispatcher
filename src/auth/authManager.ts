import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  deleteUser,
  type User,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "../db/firebase";
import type { UserProfile, UserRole } from "../types/models";
import { getLocale } from "../i18n";

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REPORTS_PER_WINDOW = 4;
const submissionTimestamps: number[] = [];

export function checkReportRateLimit(): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  while (submissionTimestamps.length > 0 && now - submissionTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    submissionTimestamps.shift();
  }
  if (submissionTimestamps.length >= MAX_REPORTS_PER_WINDOW) {
    const retryAfterSec = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - submissionTimestamps[0])) / 1000
    );
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

export function recordReportSubmissionTimestamp(): void {
  submissionTimestamps.push(Date.now());
}

export async function resolveUserProfile(user: User): Promise<UserProfile> {
  let role: UserRole = "citizen";
  let unitId: string | null = null;
  let preferredLang: "en" | "hi" = getLocale();

  try {
    const tokenResult = await user.getIdTokenResult();
    if (tokenResult.claims?.role) {
      role = tokenResult.claims.role as UserRole;
    }
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      const data = snap.data();
      if (!tokenResult.claims?.role && data.role) {
        role = data.role as UserRole;
      }
      unitId = data.unitId ?? null;
      if (data.preferredLang === "en" || data.preferredLang === "hi") {
        preferredLang = data.preferredLang;
      }
    } else {
      await setDoc(
        userRef,
        {
          uid: user.uid,
          email: user.email || "",
          displayName: user.displayName || (user.email ? user.email.split("@")[0] : "Citizen"),
          role: "citizen",
          unitId: null,
          preferredLang,
          fcmTokens: [],
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch {
    // Default safely to citizen on offline/rule error
  }

  return {
    uid: user.uid,
    email: user.email || "",
    displayName: user.displayName || (user.email ? user.email.split("@")[0] : "Operator"),
    role,
    unitId,
    preferredLang,
    fcmTokens: [],
    emailVerified: user.emailVerified,
    mfaEnrolled: false,
    createdAtMs: Date.now(),
  };
}

export async function signInOrSignUp(
  email: string,
  password: string,
  isSignup: boolean
): Promise<User> {
  if (isSignup) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    try {
      await sendEmailVerification(cred.user);
    } catch {
      // Non-fatal if verification email throttled
    }
    return cred.user;
  }
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function triggerPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function deleteMyAccountAndData(user: User): Promise<void> {
  // Anonymize or cancel user's unassigned reports and remove profile document
  const q = query(collection(db, "emergencies"), where("reporterUid", "==", user.uid));
  const snap = await getDocs(q);
  for (const d of snap.docs) {
    const data = d.data();
    if (data.status === "reported" || data.status === "Pending") {
      try {
        await setDoc(d.ref, { status: "cancelled", updatedAt: serverTimestamp() }, { merge: true });
      } catch {
        // Ignore if already transitioned
      }
    }
  }
  await deleteDoc(doc(db, "users", user.uid));
  await deleteUser(user);
}
