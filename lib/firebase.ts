import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase, type Database } from "firebase/database";
import { getFirestore, type Firestore } from "firebase/firestore";

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function getFirebaseApp(): FirebaseApp {
  if (typeof window === "undefined") {
    throw new Error("Firebase cliente sólo en el navegador");
  }
  if (!getApps().length) {
    initializeApp(config);
  }
  return getApps()[0]!;
}

let _db: Firestore | undefined;
let _rtdb: Database | undefined;

export function getDb(): Firestore {
  if (!_db) _db = getFirestore(getFirebaseApp());
  return _db;
}

export function getRtdb(): Database {
  if (!_rtdb) _rtdb = getDatabase(getFirebaseApp());
  return _rtdb;
}

export function getAuthClient() {
  return getAuth(getFirebaseApp());
}
