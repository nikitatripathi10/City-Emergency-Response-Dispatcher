import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { logStructuredEvent } from "../utils/observability";

const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "AIzaSyCsQyW9xmh1lXSYY8oPmFGAETUquWJI8JY",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "city-emergency-dispatcher.firebaseapp.com",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "city-emergency-dispatcher",
  storageBucket:
    env.VITE_FIREBASE_STORAGE_BUCKET || "city-emergency-dispatcher.firebasestorage.app",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "364720673291",
  appId: env.VITE_FIREBASE_APP_ID || "1:364720673291:web:7a37303cce58f8bcdbad0e",
};

export const app: FirebaseApp = initializeApp(firebaseConfig);
export const auth: Auth = getAuth(app);
export const db: Firestore = getFirestore(app);
export const storage: FirebaseStorage = getStorage(app);

// Activate Firebase App Check if site key is configured
if (typeof window !== "undefined" && env.VITE_RECAPTCHA_SITE_KEY) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    logStructuredEvent("info", "app_check_initialized");
  } catch (err) {
    logStructuredEvent("warn", "app_check_init_failed", { error: String(err) });
  }
}

// Connect to local Firebase Emulators when configured
if (env.VITE_USE_FIREBASE_EMULATORS === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  logStructuredEvent("info", "connected_to_firebase_emulators");
}
