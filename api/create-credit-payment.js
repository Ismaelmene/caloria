const { getAuthedUser } = require("../lib/firebaseAdmin");
const { CREDITOS_POR_PACOTE, PRECO_PACOTE_BRL } = require("../lib/budget");

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

// Cria um pagamento AVULSO (não recorrente) no Mercado Pago via Checkout Pro,
// pra comprar créditos extras de IA. Diferente da assinatura (que usa
// "preapproval"), aqui usamos "preferences" — é o fluxo certo do Mercado Pago
// pra cobrança única. Também não coletamos cartão diretamente (mesmo motivo
// da assinatura: evita escopo de PCI-DSS).
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

    const { pacotes } = req.body || {};
    const qtdPacotes = Math.max(1, Math.min(20, Number(pacotes) || 1));
    const valor = qtdPacotes * PRECO_PACOTE_BRL;
    const creditos = qtdPacotes * CREDITOS_POR_PACOTE;

    const externalReference = JSON.stringify({ uid: user.uid, tipo: "creditos", creditos });

    const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: [
          {
            title: `${creditos} créditos extras — Minha Nutri`,
            quantity: 1,
            unit_price: valor,
            currency_id: "BRL",
          },
        ],
        payer: { email: user.email },
        external_reference: externalReference,
        back_urls: {
          success: `${PUBLIC_BASE_URL}/?creditos=ok`,
          failure: `${PUBLIC_BASE_URL}/?creditos=falhou`,
          pending: `${PUBLIC_BASE_URL}/?creditos=pendente`,
        },
        auto_return: "approved",
        notification_url: `${PUBLIC_BASE_URL}/api/mp-webhook?token=${process.env.MP_WEBHOOK_SECRET || ""}`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro Mercado Pago (créditos):", data);
      return res.status(502).json({
        error: "falha ao criar pagamento de créditos",
        detalhe: JSON.stringify(data).slice(0, 300),
      });
    }

    return res.status(200).json({ checkoutUrl: data.init_point, creditos, valor });
  } catch (err) {
    console.error("Erro ao criar pagamento de créditos:", err);
    return res.status(500).json({
      error: "erro interno ao criar pagamento de créditos",
      detalhe: String(err && err.message ? err.message : err).slice(0, 300),
    });
  }
};
