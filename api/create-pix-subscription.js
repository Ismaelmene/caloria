const { getAuthedUser, db } = require("../lib/firebaseAdmin");

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE || 50);

// Cria um pagamento AVULSO (não recorrente) equivalente a 1 mês de assinatura,
// pra quem prefere pagar por Pix em vez de cartão. Diferente da assinatura por
// cartão (que usa "preapproval" e renova sozinha todo mês), aqui é uma cobrança
// única via "preferences" — o webhook, ao aprovar, libera o acesso por 30 dias
// (campo "subscriptionExpiresAt"); passado esse prazo sem um novo pagamento, o
// acesso volta a ficar bloqueado sozinho, sem cobrar nada automaticamente.
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "método não permitido" });
    }

    const user = await getAuthedUser(req);
    if (!user) {
      return res.status(401).json({ error: "não autenticado" });
    }

    if (!process.env.MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: "MP_ACCESS_TOKEN não configurado no servidor" });
    }

    const userDoc = await db.collection("users").doc(user.uid).get();
    const referralCode = userDoc.exists ? userDoc.data().referredByCode || "" : "";

    const externalReference = JSON.stringify({
      uid: user.uid,
      ref: referralCode,
      tipo: "assinatura_manual",
    });

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: [
          {
            title: "Assinatura mensal (Pix) — Minha Nutri",
            quantity: 1,
            unit_price: MONTHLY_PRICE,
            currency_id: "BRL",
          },
        ],
        payer: { email: user.email },
        external_reference: externalReference,
        back_urls: {
          success: `${PUBLIC_BASE_URL}/?assinatura=ok`,
          failure: `${PUBLIC_BASE_URL}/?assinatura=falhou`,
          pending: `${PUBLIC_BASE_URL}/?assinatura=pendente`,
        },
        auto_return: "approved",
        notification_url: `${PUBLIC_BASE_URL}/api/mp-webhook?token=${process.env.MP_WEBHOOK_SECRET || ""}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro Mercado Pago (assinatura manual):", data);
      return res.status(502).json({
        error: "falha ao criar pagamento da assinatura",
        detalhe: JSON.stringify(data).slice(0, 300),
      });
    }

    return res.status(200).json({ checkoutUrl: data.init_point });
  } catch (err) {
    console.error("Erro ao criar assinatura manual:", err);
    return res.status(500).json({
      error: "erro interno ao criar assinatura",
      detalhe: String(err && err.message ? err.message : err).slice(0, 300),
    });
  }
};
