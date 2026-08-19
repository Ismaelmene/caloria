const { getAuthedUser, getUserRole, db, admin } = require("../lib/firebaseAdmin");

function randomCode(len = 8) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Uso:
// POST /api/promote-role  { targetUid, role: "affiliate" | "admin" | "user", commissionRate?, name? }
// Header: Authorization: Bearer <idToken de quem está chamando>
//
// Regra: só um admin pode promover outras pessoas. EXCEÇÃO: se ainda não existir
// nenhum admin no sistema, a própria pessoa pode virar admin uma única vez enviando
// o header "x-bootstrap-secret" com o valor de ADMIN_BOOTSTRAP_SECRET (ver .env.example).
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "método não permitido" });
  }

  const caller = await getAuthedUser(req);
  if (!caller) return res.status(401).json({ error: "não autenticado" });

  const { targetUid, role, commissionRate, name } = req.body || {};
  if (!targetUid || !["affiliate", "admin", "user"].includes(role)) {
    return res.status(400).json({ error: "informe targetUid e role válido" });
  }

  const callerRole = await getUserRole(caller.uid);
  const bootstrapSecret = req.headers["x-bootstrap-secret"];

  const isBootstrap =
    role === "admin" &&
    targetUid === caller.uid &&
    bootstrapSecret &&
    bootstrapSecret === process.env.ADMIN_BOOTSTRAP_SECRET;

  if (callerRole !== "admin" && !isBootstrap) {
    return res.status(403).json({ error: "só um admin pode fazer isso" });
  }

  const userRef = db.collection("users").doc(targetUid);
  await userRef.set({ role }, { merge: true });

  if (role === "affiliate") {
    const affiliateRef = db.collection("affiliates").doc(targetUid);
    const existing = await affiliateRef.get();
    const referralCode = existing.exists ? existing.data().referralCode : randomCode();
    await affiliateRef.set(
      {
        name: name || existing.data()?.name || "",
        referralCode,
        commissionRate:
          typeof commissionRate === "number"
            ? commissionRate
            : Number(process.env.DEFAULT_COMMISSION_RATE || 0.3),
        totalEarned: existing.exists ? existing.data().totalEarned || 0 : 0,
        createdAt: existing.exists ? existing.data().createdAt : admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return res.status(200).json({ ok: true, role, referralCode });
  }

  res.status(200).json({ ok: true, role });
};
