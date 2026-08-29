const { db, admin } = require("../lib/firebaseAdmin");

// Cadastre esta URL no painel do Mercado Pago como:
//   https://SEU-PROJETO.vercel.app/api/mp-webhook?token=SEU_MP_WEBHOOK_SECRET
// (o token na query string é uma proteção simples nossa; o Mercado Pago também
// assina as notificações — para produção, vale reforçar validando o header
// "x-signature" conforme a documentação oficial de webhooks do Mercado Pago)

async function fetchMP(path) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Mercado Pago respondeu ${res.status} em ${path}`);
  return res.json();
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// O Mercado Pago manda o tipo de pagamento em "payment_type_id" (ex: "pix",
// "credit_card", "debit_card", "account_money", "ticket"...). Traduzimos pra
// um rótulo simples que o painel admin exibe direto.
function rotuloMetodoPagamento(payment) {
  const tipo = payment.payment_type_id || "";
  if (tipo === "pix") return "Pix";
  if (tipo === "credit_card") return "Cartão de crédito";
  if (tipo === "debit_card") return "Cartão de débito";
  if (tipo === "ticket") return "Boleto";
  if (tipo === "account_money") return "Saldo Mercado Pago";
  return tipo || "—";
}

async function handleApprovedPayment(payment) {
  let ref = {};
  try {
    ref = JSON.parse(payment.external_reference || "{}");
  } catch (e) {
    console.warn("external_reference não era um JSON válido:", payment.external_reference);
  }
  const { uid, ref: referralCode, tipo, creditos } = ref;
  if (!uid) {
    console.warn("Pagamento aprovado sem uid no external_reference, ignorando.");
    return;
  }

  // Compra avulsa de créditos extras — não é a assinatura, então não mexe no
  // status de assinatura nem no ciclo de orçamento mensal, só soma créditos.
  if (tipo === "creditos") {
    await db.collection("users").doc(uid).set(
      { extraCredits: admin.firestore.FieldValue.increment(Number(creditos) || 0) },
      { merge: true }
    );

    await db.collection("payments").doc(String(payment.id)).set({
      userId: uid,
      amount: payment.transaction_amount,
      period: currentPeriod(),
      tipo: "creditos",
      creditosComprados: Number(creditos) || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  const userRef = db.collection("users").doc(uid);
  const metodoPagamento = rotuloMetodoPagamento(payment);

  // Só guardamos "primeiro pagamento" uma vez — se já existir, mantém o valor
  // original em vez de sobrescrever a cada renovação.
  const userSnapAntes = await userRef.get();
  const jaTinhaPrimeiroPagamento = userSnapAntes.exists && userSnapAntes.data().firstPaymentAt;

  await userRef.set(
    {
      subscriptionStatus: "active",
      lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
      lastPaymentAmount: payment.transaction_amount,
      lastPaymentMethod: metodoPagamento,
      ...(jaTinhaPrimeiroPagamento ? {} : { firstPaymentAt: admin.firestore.FieldValue.serverTimestamp() }),
      // cada pagamento aprovado da assinatura (inclusive a primeira cobrança)
      // marca o início de um novo ciclo de orçamento de IA de R$25 — assim o
      // reset acontece na data de renovação de cada pessoa, não num dia fixo
      budgetSpentBRL: 0,
      budgetCycleStart: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // registro simples de todo pagamento aprovado, para o painel admin somar receita
  await db.collection("payments").doc(String(payment.id)).set({
    userId: uid,
    amount: payment.transaction_amount,
    period: currentPeriod(),
    referralCode: referralCode || null,
    paymentMethod: metodoPagamento,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (referralCode) {
    const affiliateSnap = await db
      .collection("affiliates")
      .where("referralCode", "==", referralCode)
      .limit(1)
      .get();

    if (!affiliateSnap.empty) {
      const affiliateDoc = affiliateSnap.docs[0];
      const affiliate = affiliateDoc.data();
      const rate = typeof affiliate.commissionRate === "number" ? affiliate.commissionRate : 0.3;
      const commissionAmount = Number((payment.transaction_amount * rate).toFixed(2));
      const period = currentPeriod();
      const commissionId = `${affiliateDoc.id}_${uid}_${period}`;

      await db.collection("commissions").doc(commissionId).set(
        {
          affiliateId: affiliateDoc.id,
          affiliateName: affiliate.name || "",
          userId: uid,
          period,
          baseAmount: payment.transaction_amount,
          commissionRate: rate,
          commissionAmount,
          status: "accrued",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await affiliateDoc.ref.set(
        {
          totalEarned: admin.firestore.FieldValue.increment(commissionAmount),
        },
        { merge: true }
      );
    }
  }
}

async function handlePreapprovalUpdate(preapproval) {
  let ref = {};
  try {
    ref = JSON.parse(preapproval.external_reference || "{}");
  } catch (e) {}
  const { uid } = ref;
  if (!uid) return;

  const statusMap = {
    authorized: "active",
    paused: "paused",
    cancelled: "canceled",
    pending: "pending_payment",
  };

  await db
    .collection("users")
    .doc(uid)
    .set(
      { subscriptionStatus: statusMap[preapproval.status] || preapproval.status },
      { merge: true }
    );
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("ok"); // Mercado Pago às vezes faz GET de teste
  }

  const secret = req.query.token;
  if (process.env.MP_WEBHOOK_SECRET && secret !== process.env.MP_WEBHOOK_SECRET) {
    return res.status(401).send("token inválido");
  }

  const type = req.query.type || req.body?.type;
  const dataId = req.query["data.id"] || req.body?.data?.id;

  try {
    if (type === "payment" && dataId) {
      const payment = await fetchMP(`/v1/payments/${dataId}`);
      if (payment.status === "approved") {
        await handleApprovedPayment(payment);
      }
    } else if ((type === "subscription_preapproval" || type === "preapproval") && dataId) {
      const preapproval = await fetchMP(`/preapproval/${dataId}`);
      await handlePreapprovalUpdate(preapproval);
    }
    res.status(200).send("ok");
  } catch (err) {
    console.error("Erro no webhook do Mercado Pago:", err.message);
    // devolve 200 mesmo assim para o MP não ficar reenviando indefinidamente;
    // o erro já foi logado para investigação manual
    res.status(200).send("erro registrado");
  }
};
