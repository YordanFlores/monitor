import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not set (JSON string of the service account)"
    );
  }

  const cred = JSON.parse(raw) as admin.ServiceAccount;
  const databaseURL = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL;

  return admin.initializeApp({
    credential: admin.credential.cert(cred),
    databaseURL,
  });
}

export function getAdmin() {
  return initAdmin();
}

export function getFirestoreAdmin() {
  return getAdmin().firestore();
}

export function getRtdbAdmin() {
  return getAdmin().database();
}
