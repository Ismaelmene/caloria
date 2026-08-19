const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn(
      "[aviso] FIREBASE_SERVICE_ACCOUNT não configurada — as funções que usam Firestore vão falhar."
    );
  } else {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const auth = admin.apps.length ? admin.auth() : null;

// Confere o token de login (Firebase Auth) enviado pelo app no header Authorization: Bearer <token>
// e devolve os dados do usuário autenticado, ou null se inválido.
async function getAuthedUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded; // contém uid, email, etc.
  } catch (e) {
    return null;
  }
}

async function getUserRole(uid) {
  const doc = await db.collection("users").doc(uid).get();
  if (!doc.exists) return null;
  return doc.data().role || "user";
}

module.exports = { admin, db, auth, getAuthedUser, getUserRole };
