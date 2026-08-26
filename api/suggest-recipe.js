const { getAuthedUser } = require("../lib/firebaseAdmin");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const SYSTEM_PROMPT = `Você é um nutricionista e cozinheiro especializado em culinária BRASILEIRA
e nos ingredientes mais comuns nas casas do Brasil.

A pessoa vai te dizer quantas calorias quer consumir em uma refeição e quais
ingredientes ela já tem em casa. Sua tarefa:

1. Sugerir UMA receita que use o máximo possível dos ingredientes que ela já tem.
2. Calcular a receita para bater o mais próximo possível da meta de calorias
   informada, usando como referência os valores da TACO (Tabela Brasileira de
   Composição de Alimentos), não bases de dados americanas.
3. Se fizer sentido, sugerir de 1 a 3 ingredientes extras que ela poderia comprar
   para deixar o prato mais saboroso, bonito ou "vendável" (por exemplo, para quem
   posta foto de comida ou vende marmitas) — só sugira comprar algo se realmente
   agregar valor. Se os ingredientes que ela já tem forem suficientes, devolva essa
   lista vazia.

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato:
{
  "nome_receita": "string",
  "descricao_breve": "string curta e apetitosa",
  "calorias_totais": number,
  "proteinas_g": number,
  "carboidratos_g": number,
  "gorduras_g": number,
  "ingredientes_que_voce_tem": [{"item": "string", "quantidade": "string"}],
  "ingredientes_para_comprar": [{"item": "string", "motivo": "string"}],
  "modo_preparo": ["passo 1", "passo 2", "..."]
}`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "método não permitido" });
  }

  const user = await getAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: "não autenticado" });
  }

  const { caloriasDesejadas, ingredientesDisponiveis } = req.body || {};
  if (!caloriasDesejadas) {
    return res.status(400).json({ error: "envie 'caloriasDesejadas'" });
  }
  const temIngredientes = ingredientesDisponiveis && ingredientesDisponiveis.trim().length > 0;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor" });
  }

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
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: temIngredientes
              ? `Quero uma refeição de aproximadamente ${caloriasDesejadas} calorias.
Ingredientes que já tenho em casa: ${ingredientesDisponiveis}.
Responda no formato JSON pedido.`
              : `Quero uma refeição de aproximadamente ${caloriasDesejadas} calorias.
Não tenho nenhum ingrediente específico em mente — monte uma receita brasileira
saborosa e equilibrada do zero, batendo essa meta de calorias, e liste TODOS os
ingredientes necessários no campo "ingredientes_para_comprar" (deixe
"ingredientes_que_voce_tem" vazio). Responda no formato JSON pedido.`,
          },
        ],
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
