const { getAuthedUser, db } = require("../lib/firebaseAdmin");

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE || 50);

// Cria uma assinatura (preapproval) no Mercado Pago.
//
// Duas formas de chamar esta função:
// 1) Sem "token" no corpo da requisição: cria a assinatura no modo antigo,
//    devolvendo uma URL de checkout do próprio Mercado Pago pra redirecionar
//    o usuário (fluxo usado como reserva / nos avisos de limite atingido).
// 2) Com "token" no corpo (vindo do Card Payment Brick do Mercado Pago,
//    embutido na nossa própria tela de pagamento): cria a assinatura já
//    autorizada, sem redirecionar ninguém pra fora do app. O cartão nunca
//    passa pelo nosso servidor — o token já vem pronto do Mercado Pago
//    (tokenizado direto no navegador da pessoa), então continuamos fora do
//    escopo de PCI-DSS.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "método não permitido" });
  }

  const authedUser = await getAuthedUser(req);
  if (!authedUser) {
    return res.status(401).json({ error: "não autenticado" });
  }

  if (!process.env.MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: "MP_ACCESS_TOKEN não configurado no servidor" });
  }

  // código do afiliado que indicou esse usuário (se houver) — lido do Firestore,
  // não confiamos em valor enviado pelo cliente para evitar fraude de comissão
  const userDoc = await db.collection("users").doc(authedUser.uid).get();
  const referralCode = userDoc.exists ? userDoc.data().referredByCode || "" : "";

  const externalReference = JSON.stringify({ uid: authedUser.uid, ref: referralCode });
  const { token } = req.body || {};

  const body = {
    reason: "Assinatura mensal — Minha Nutri",
    payer_email: authedUser.email,
    external_reference: externalReference,
    back_url: `${PUBLIC_BASE_URL}/?checkout=retorno`,
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: MONTHLY_PRICE,
      currency_id: "BRL",
    },
  };

  if (token) {
    body.card_token_id = token;
    body.status = "authorized";
  }

  try {
    const response = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro Mercado Pago:", data);
      return res.status(502).json({ error: "falha ao criar assinatura no Mercado Pago", details: data });
    }

    const statusAssinatura = data.status === "authorized" ? "active" : "pending_payment";

    // salva o id da preapproval no usuário, para conseguirmos correlacionar no webhook
    await db.collection("users").doc(authedUser.uid).set(
      {
        mpPreapprovalId: data.id,
        subscriptionStatus: statusAssinatura,
        ...(statusAssinatura === "active"
          ? {
              subscriptionPaymentMethod: "cartao_recorrente",
              lastPaymentMethod: "Cartão de crédito",
              budgetSpentBRL: 0,
              budgetCycleStart: new Date(),
            }
          : {}),
      },
      { merge: true }
    );

    if (token) {
      // fluxo embutido: já sabemos o resultado na hora, sem precisar de redirect
      return res.status(200).json({ status: data.status, subscriptionActive: statusAssinatura === "active" });
    }

    res.status(200).json({ checkoutUrl: data.init_point });
  } catch (err) {
    console.error("Erro ao criar checkout:", err.message);
    res.status(500).json({ error: "erro interno ao criar checkout" });
  }
};
