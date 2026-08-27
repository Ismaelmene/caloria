const { getAuthedUser } = require("../lib/firebaseAdmin");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const OBJETIVO_TEXTO = {
  perder: "A pessoa quer PERDER PESO — priorize alimentos com boa saciedade, proteína magra e fibras, e evite excesso de frituras e açúcar.",
  ganhar: "A pessoa quer GANHAR PESO — priorize refeições mais calóricas mas nutritivas (boas fontes de carboidrato, gordura boa e proteína), evitando só 'calorias vazias'.",
  manter: "A pessoa quer MANTER o peso atual — busque um cardápio equilibrado e variado.",
};

const DURACAO_TEXTO = {
  refeicao: {
    instrucao: "Gere APENAS 1 refeição única.",
    diasEsperados: 1,
    refeicoesPorDia: 1,
    maxTokens: 1200,
  },
  dia: {
    instrucao: "Gere um cardápio para 1 dia inteiro, dividido em 4 refeições: café da manhã, almoço, lanche da tarde e jantar. A soma das 4 deve bater com a meta de calorias informada (que é o total do DIA, não de uma refeição só).",
    diasEsperados: 1,
    refeicoesPorDia: 4,
    maxTokens: 2200,
  },
  semana: {
    instrucao: "Gere um cardápio para 7 dias (segunda a domingo), cada dia com 4 refeições (café da manhã, almoço, lanche da tarde e jantar), variando os pratos ao longo da semana para não repetir sempre a mesma coisa. A soma diária de calorias deve bater com a meta informada (que é o total por DIA).",
    diasEsperados: 7,
    refeicoesPorDia: 4,
    maxTokens: 6500,
  },
  mes: {
    instrucao: "Gere um cardápio-modelo de 7 dias (segunda a domingo) pensado para ser reaproveitado/repetido ao longo de um mês inteiro, variando os pratos ao longo da semana. Cada dia com 4 refeições (café da manhã, almoço, lanche da tarde e jantar). A soma diária de calorias deve bater com a meta informada (que é o total por DIA). No campo 'resumo', deixe claro que é um modelo semanal pensado para repetir/variar ao longo do mês.",
    diasEsperados: 7,
    refeicoesPorDia: 4,
    maxTokens: 6500,
  },
};

function buildSystemPrompt(duracaoInfo, objetivoTexto, temIngredientes) {
  return `Você é um nutricionista e cozinheiro especializado em culinária BRASILEIRA
e nos ingredientes mais comuns nas casas do Brasil. Use como referência nutricional
a TACO (Tabela Brasileira de Composição de Alimentos), não bases de dados americanas.

${objetivoTexto}

${duracaoInfo.instrucao}

${
  temIngredientes
    ? `A pessoa te disse quais ingredientes já tem em casa — priorize usá-los ao
máximo nas receitas. O que faltar para completar as receitas, liste em
"ingredientes_para_comprar" de cada refeição.`
    : `A pessoa não tem ingredientes específicos em mente — monte as receitas do
zero e liste TODOS os ingredientes necessários em "ingredientes_para_comprar" de
cada refeição (deixe "ingredientes_que_voce_tem" vazio em cada uma).`
}

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato exato:
{
  "titulo": "string curta",
  "resumo": "string curta explicando o plano",
  "dias": [
    {
      "dia": "string (ex: 'Refeição', 'Hoje', 'Segunda-feira', 'Terça-feira'...)",
      "refeicoes": [
        {
          "nome_refeicao": "string (ex: 'Café da manhã', 'Almoço', 'Lanche da tarde', 'Jantar' — ou vazio se for só 1 refeição)",
          "prato": "string",
          "calorias": number,
          "proteinas_g": number,
          "carboidratos_g": number,
          "gorduras_g": number,
          "ingredientes_que_voce_tem": [{"item": "string", "quantidade": "string"}],
          "ingredientes_para_comprar": [{"item": "string", "motivo": "string"}],
          "modo_preparo": ["passo 1", "passo 2"]
        }
      ]
    }
  ]
}

Gere exatamente ${duracaoInfo.diasEsperados} item(ns) em "dias", cada um com
${duracaoInfo.refeicoesPorDia} refeições.`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "método não permitido" });
  }

  const user = await getAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: "não autenticado" });
  }

  const { caloriasDesejadas, ingredientesDisponiveis, duracao, objetivo } = req.body || {};
  if (!caloriasDesejadas) {
    return res.status(400).json({ error: "envie 'caloriasDesejadas'" });
  }

  const duracaoInfo = DURACAO_TEXTO[duracao] || DURACAO_TEXTO.refeicao;
  const objetivoTexto = OBJETIVO_TEXTO[objetivo] || OBJETIVO_TEXTO.manter;
  const temIngredientes = Boolean(ingredientesDisponiveis && ingredientesDisponiveis.trim().length > 0);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor" });
  }

  const userMessage = temIngredientes
    ? `Quero ${duracaoInfo.diasEsperados > 1 ? "aproximadamente " + caloriasDesejadas + " calorias por dia" : "uma refeição de aproximadamente " + caloriasDesejadas + " calorias"}.
Ingredientes que já tenho em casa: ${ingredientesDisponiveis}.
Responda no formato JSON pedido.`
    : `Quero ${duracaoInfo.diasEsperados > 1 ? "aproximadamente " + caloriasDesejadas + " calorias por dia" : "uma refeição de aproximadamente " + caloriasDesejadas + " calorias"}.
Não tenho ingredientes específicos em mente. Responda no formato JSON pedido.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: duracaoInfo.maxTokens,
        system: buildSystemPrompt(duracaoInfo, objetivoTexto, temIngredientes),
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Erro Anthropic:", errText);
      return res.status(502).json({ error: "falha ao consultar a IA" });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const rawText = textBlock ? textBlock.text : "{}";

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Não foi possível interpretar a resposta da IA:", rawText);
      return res.status(502).json({ error: "resposta da IA em formato inesperado", raw: rawText });
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error("Erro ao gerar receita:", err.message);
    res.status(500).json({ error: "erro interno ao gerar a receita" });
  }
};
