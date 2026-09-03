const { getAuthedUser, getUserRole, db, auth } = require("../lib/firebaseAdmin");

// Uso:
// POST /api/admin-delete-user  { targetUid }
// Header: Authorization: Bearer <idToken de quem está chamando>
//
// Só um admin pode excluir usuário. Apaga o documento da pessoa em "users"
// (e tudo que tem dentro dele — refeições, pesos, ciclos de plano, chat —
// via recursiveDelete), o cadastro de login dela no Firebase Auth (senão o
// e-mail continuaria "ocupado" pra sempre), os chamados de suporte que ela
// abriu, e o cadastro de afiliado (se ela tiver um). Não é reversível.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "método não permitido" });
  }

  const caller = await getAuthedUser(req);
  if (!caller) return res.status(401).json({ error: "não autenticado" });

  const callerRole = await getUserRole(caller.uid);
  if (callerRole !== "admin") {
    return res.status(403).json({ error: "só um admin pode fazer isso" });
  }

  const { targetUid } = req.body || {};
  if (!targetUid) {
    return res.status(400).json({ error: "informe targetUid" });
  }
  if (targetUid === caller.uid) {
    return res.status(400).json({ error: "você não pode excluir a própria conta por aqui" });
  }

  try {
    const targetRef = db.collection("users").doc(targetUid);
    const targetSnap = await targetRef.get();
    if (targetSnap.exists && targetSnap.data().role === "admin") {
      return res.status(400).json({ error: "essa conta é admin — não dá pra excluir por aqui, por segurança" });
    }

    // Apaga o documento do usuário e tudo que tem dentro (subcoleções:
    // meals, weights, nutritionCycles, chatMessages) de uma vez só.
    await db.recursiveDelete(targetRef);

    // Chamados de suporte abertos por essa pessoa — apaga junto pra não
    // sobrar chamado "órfão" no seu painel.
    const ticketsSnap = await db.collection("supportTickets").where("uid", "==", targetUid).get();
    const batch = db.batch();
    ticketsSnap.forEach((doc) => batch.delete(doc.ref));
    if (!ticketsSnap.empty) await batch.commit();

    // Cadastro de afiliado, se ela tiver um (o id do documento é o mesmo uid).
    await db.collection("affiliates").doc(targetUid).delete().catch(() => {});

    // Por último, apaga o login dela no Firebase Auth — se já não existir
    // mais lá por algum motivo, ignora o erro e segue o jogo.
    await auth.deleteUser(targetUid).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro ao excluir usuário:", err);
    return res.status(500).json({ error: "erro ao excluir usuário: " + err.message });
  }
};
