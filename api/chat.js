const { getAuthedUser } = require("../lib/firebaseAdmin");
const { verificarSaldo, registrarGasto, ORCAMENTO_MENSAL_BRL } = require("../lib/budget");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

function buildSystemPrompt(perfilResumo) {
  return `Você é a "Nutri", a assistente de nutrição por IA do app Minha Nutri.
Converse em português do Brasil, de forma acolhedora, direta e prática — como uma
nutricionista de confiança mandando mensagem no WhatsApp, não como uma bula.

Use como referência nutricional a TACO (Tabela Brasileira de Composição de
Alimentos). Respostas curtas e objetivas (no máximo 2-3 parágrafos curtos, ou uma
lista curta quando fizer sentido).

${perfilResumo ? `Contexto sobre esta pessoa (use pra personalizar a resposta):\n${perfilResumo}` : ""}

Se a pergunta envolver um sintoma físico sério, uma condição de saúde específica,
ou fugir do escopo de alimentação/nutrição, oriente com naturalidade a buscar um
médico ou nutricionista humano — sem soar como aviso legal robotizado. Você é uma
ferramenta de apoio baseada em IA, não substitui uma consulta profissional.`;
}

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

    const { mensagem, historico, perfilResumo } = req.body || {};
    if (!mensagem || !String(mensagem).trim()) {
      return res.status(400).json({ error: "envie 'mensagem'" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor" });
    }

    const saldo = await verificarSaldo(user.uid);
    if (!saldo.assinaturaOk) {
      return res.status(402).json({
        error: "sem_assinatura",
        mensagem: "Assine o Minha Nutri pra falar com a Nutri.",
      });
    }
    if (!saldo.podeUsar) {
      return res.status(402).json({
        error: "limite_atingido",
        mensagem: "Você atingiu seu limite mensal de IA. Compre créditos extras pra continuar conversando com a Nutri.",
        gasto: saldo.gasto,
        orcamento: ORCAMENTO_MENSAL_BRL,
      });
    }

    // histórico vem do front-end já recortado (últimas mensagens da conversa);
    // limitamos de novo aqui por segurança pra não deixar o contexto gigante
    const mensagensAnthropic = Array.isArray(historico)
      ? historico
          .filter((m) => m && m.text && (m.role === "user" || m.role === "assistant"))
          .slice(-10)
          .map((m) => ({ role: m.role, content: String(m.text).slice(0, 2000) }))
      : [];
    mensagensAnthropic.push({ role: "user", content: String(mensagem).slice(0, 2000) });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: buildSystemPrompt(perfilResumo || ""),
        messages: mensagensAnthropic,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Erro Anthropic (chat):", response.status, errText);
      return res.status(502).json({
        error: "falha ao consultar a IA",
        detalhe: `status ${response.status}: ${errText}`.slice(0, 300),
      });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const resposta = textBlock ? textBlock.text : "Desculpa, não consegui responder agora. Tenta de novo?";

    const custo = await registrarGasto(saldo.ref, data.usage, saldo.usaraCredito);

    return res.status(200).json({ resposta, usouCredito: saldo.usaraCredito, custo });
  } catch (err) {
    console.error("Erro no chat:", err);
    return res.status(500).json({
      error: "erro interno no chat",
      detalhe: String(err && err.message ? err.message : err).slice(0, 300),
    });
  }
};

module.exports.config = { maxDuration: 30 };
