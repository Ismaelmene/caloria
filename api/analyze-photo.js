const { getAuthedUser } = require("../lib/firebaseAdmin");
const { repairAndParseJSON } = require("../lib/jsonRepair");
const { verificarSaldo, registrarGasto, ORCAMENTO_MENSAL_BRL } = require("../lib/budget");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const SYSTEM_PROMPT = `Você é um nutricionista especializado em culinária BRASILEIRA.
Analise a foto do prato de comida e identifique os alimentos considerando pratos e
ingredientes típicos do Brasil (ex: feijão, arroz, farofa, feijoada, coxinha, pão de
queijo, tapioca, açaí, prato feito/PF, marmita, comida por peso de self-service, etc).

Estime as calorias e macronutrientes usando como referência os valores da TACO
(Tabela Brasileira de Composição de Alimentos), e não bases de dados americanas.

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{
  "prato_identificado": "nome do prato em português",
  "itens": [
    {"alimento": "string", "porcao_estimada": "string, ex: '150g' ou '1 unidade'", "calorias": number}
  ],
  "calorias_totais": number,
  "proteinas_g": number,
  "carboidratos_g": number,
  "gorduras_g": number,
  "confianca": "alta" | "media" | "baixa",
  "observacao": "string curta, ex: alertar se a foto não permitiu boa identificação"
}`;

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "método não permitido" });
    }

    let user;
    try {
      user = await getAuthedUser(req);
    } catch (authErr) {
      console.error("Erro na autenticação:", authErr);
      return res.status(500).json({
        error: "falha ao verificar login",
        detalhe: String(authErr && authErr.message ? authErr.message : authErr).slice(0, 300),
      });
    }
    if (!user) {
      return res.status(401).json({ error: "não autenticado" });
    }

    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "envie 'imageBase64' (sem o prefixo data:...)" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor" });
    }

    const saldo = await verificarSaldo(user.uid);
    if (!saldo.podeUsar) {
      return res.status(402).json({
        error: "limite_atingido",
        mensagem: "Você atingiu seu limite mensal de IA. Compre créditos extras pra continuar usando.",
        gasto: saldo.gasto,
        orcamento: ORCAMENTO_MENSAL_BRL,
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType || "image/jpeg",
                  data: imageBase64,
                },
              },
              {
                type: "text",
                text: "Analise esta foto do meu prato e responda no formato JSON pedido.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Erro Anthropic:", response.status, errText);
      return res.status(502).json({
        error: "falha ao consultar a IA de visão",
        detalhe: `status ${response.status}: ${errText}`.slice(0, 300),
      });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const rawText = textBlock ? textBlock.text : "{}";

    let parsed;
    try {
      const resultado = repairAndParseJSON(rawText);
      parsed = resultado.parsed;
    } catch (e) {
      console.error("Não foi possível interpretar a resposta da IA:", rawText);
      return res.status(502).json({
        error: "resposta da IA em formato inesperado",
        detalhe: "A resposta ficou grande demais e foi cortada no meio. Tente de novo.",
        raw: rawText.slice(0, 500),
      });
    }

    const custo = await registrarGasto(saldo.ref, data.usage, saldo.usaraCredito);

    return res.status(200).json({ ...parsed, usouCredito: saldo.usaraCredito, custo });
  } catch (err) {
    console.error("Erro ao analisar foto:", err);
    return res.status(500).json({
      error: "erro interno ao analisar a foto",
      detalhe: String(err && err.message ? err.message : err).slice(0, 300),
    });
  }
};

module.exports.config = { maxDuration: 30 };
