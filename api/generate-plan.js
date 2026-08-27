const { getAuthedUser } = require("../lib/firebaseAdmin");
const { repairAndParseJSON } = require("../lib/jsonRepair");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const ATIVIDADE_FATOR = {
  sedentario: 1.2,
  leve: 1.375,
  moderado: 1.55,
  intenso: 1.725,
  muito_intenso: 1.9,
};

const OBJETIVO_TEXTO = {
  perder:
    "A pessoa quer PERDER PESO de forma saudável — priorize alimentos com boa saciedade, proteína magra e fibras, e evite excesso de frituras e açúcar, mas sem ser um cardápio extremamente restritivo.",
  ganhar:
    "A pessoa quer GANHAR PESO (massa) — priorize refeições mais calóricas mas nutritivas (boas fontes de carboidrato, gordura boa e proteína), evitando só 'calorias vazias'.",
  manter: "A pessoa quer MANTER o peso atual — busque um cardápio equilibrado e variado.",
};

function calcularCalorias({ pesoAtual, alturaCm, idade, sexo, nivelAtividade, objetivo }) {
  // Fórmula de Mifflin-St Jeor (referência padrão em nutrição)
  const bmr =
    sexo === "M"
      ? 10 * pesoAtual + 6.25 * alturaCm - 5 * idade + 5
      : 10 * pesoAtual + 6.25 * alturaCm - 5 * idade - 161;

  const fator = ATIVIDADE_FATOR[nivelAtividade] || ATIVIDADE_FATOR.moderado;
  const tdee = bmr * fator;

  let ajuste = 0;
  if (objetivo === "perder") ajuste = -500;
  if (objetivo === "ganhar") ajuste = 400;

  let calorias = Math.round(tdee + ajuste);

  // piso de segurança pra nunca sugerir uma dieta perigosamente baixa
  const pisoSeguranca = sexo === "M" ? 1500 : 1200;
  if (calorias < pisoSeguranca) calorias = pisoSeguranca;

  return { bmr: Math.round(bmr), tdee: Math.round(tdee), calorias };
}

// Compara o resultado do ciclo anterior (peso inicial x peso final) com a meta
// e decide se mantém a mesma meta calórica ou ajusta um pouco.
function avaliarProgresso(cicloAnterior, calorias, objetivo) {
  if (!cicloAnterior || cicloAnterior.pesoFinal == null || cicloAnterior.pesoInicial == null) {
    return { calorias, ajusteAplicado: "Primeiro cálculo do seu plano." };
  }

  const delta = cicloAnterior.pesoFinal - cicloAnterior.pesoInicial; // negativo = emagreceu

  if (objetivo === "perder") {
    if (delta <= -0.3) {
      return {
        calorias,
        ajusteAplicado: `Você perdeu ${Math.abs(delta).toFixed(1)} kg na última semana — o ritmo está bom, mantivemos a mesma meta calórica.`,
      };
    }
    return {
      calorias: calorias - 150,
      ajusteAplicado: `Seu peso quase não mudou na última semana (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kg) — reduzimos um pouco mais as calorias pra retomar o progresso.`,
    };
  }

  if (objetivo === "ganhar") {
    if (delta >= 0.3) {
      return {
        calorias,
        ajusteAplicado: `Você ganhou ${delta.toFixed(1)} kg na última semana — o ritmo está bom, mantivemos a mesma meta calórica.`,
      };
    }
    return {
      calorias: calorias + 150,
      ajusteAplicado: `Seu peso quase não mudou na última semana (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kg) — aumentamos um pouco mais as calorias pra favorecer o ganho.`,
    };
  }

  return {
    calorias,
    ajusteAplicado: `Seu peso variou ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} kg na última semana — mantivemos o cardápio equilibrado.`,
  };
}

const DIAS_SEMANA = [
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
  "Domingo",
];

// Em vez de pedir 7 dias 100% diferentes pra IA (o que deixa a resposta enorme
// e mais fácil de cortar no meio), pedimos só 3 cardápios-modelo diferentes e
// alternamos eles ao longo dos 7 dias da semana — a pessoa não come a mesma
// coisa todo dia, mas também não cansa de tantas receitas novas de uma vez.
function montarSemanaAPartirDasVariacoes(variacoes) {
  if (!Array.isArray(variacoes) || variacoes.length === 0) return [];
  return DIAS_SEMANA.map((diaNome, i) => {
    const variacao = variacoes[i % variacoes.length] || {};
    return {
      dia: diaNome,
      refeicoes: (variacao.refeicoes || []).map((r) => ({ ...r })),
    };
  });
}

function buildSystemPrompt(caloriasAlvo, objetivoTexto, temIngredientes) {
  return `Você é um nutricionista especializado em culinária BRASILEIRA e usa a TACO
(Tabela Brasileira de Composição de Alimentos) como referência nutricional — não use
bases de dados americanas.

${objetivoTexto}

Monte exatamente 3 cardápios-modelo DIFERENTES entre si (chame-os de "Opção A",
"Opção B" e "Opção C"), cada um com 4 refeições: café da manhã, almoço, lanche da
tarde e jantar. Esses 3 cardápios vão se alternar ao longo da semana —
a ideia é dar variedade real (pratos, proteínas e modos de preparo diferentes em
cada opção) sem precisar inventar 7 cardápios diferentes, porque senão a pessoa
cansa de tanta coisa nova. A soma diária de calorias de CADA uma das 3 opções deve
ficar próxima de ${caloriasAlvo} kcal, priorizando alimentos comuns e acessíveis no
Brasil.

${
  temIngredientes
    ? `A pessoa te disse quais ingredientes já tem em casa — priorize usá-los ao
máximo nos 3 cardápios. O que faltar para completar as receitas, liste em
"ingredientes_para_comprar" de cada refeição.`
    : `A pessoa não tem ingredientes específicos em mente — monte os cardápios do
zero e liste TODOS os ingredientes necessários em "ingredientes_para_comprar" de
cada refeição (deixe "ingredientes_que_voce_tem" vazio em cada uma).`
}

Seja DIRETO E CONCISO em cada campo — isso é importante pra resposta inteira
caber no limite de tamanho: "resumo" com no máximo 1-2 frases curtas; "modo_preparo"
com no máximo 3 passos curtos (uma frase cada); "ingredientes_para_comprar" com no
máximo 4 itens, e "motivo" com poucas palavras (ou "" se não precisar explicar).

Responda SOMENTE com um JSON válido, sem texto antes ou depois, no formato exato:
{
  "titulo": "string curta",
  "resumo": "string curta explicando o plano",
  "variacoes": [
    {
      "nome": "string (ex: 'Opção A')",
      "refeicoes": [
        {
          "nome_refeicao": "string (ex: 'Café da manhã', 'Almoço', 'Lanche da tarde', 'Jantar')",
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

Gere exatamente 3 itens em "variacoes", cada um com 4 refeições.`;
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

    const { pesoAtual, alturaCm, idade, sexo, nivelAtividade, objetivo, cicloAnterior, ingredientesDisponiveis } =
      req.body || {};

    if (!pesoAtual || !alturaCm || !idade || !sexo) {
      return res.status(400).json({ error: "envie 'pesoAtual', 'alturaCm', 'idade' e 'sexo'" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no servidor" });
    }

    const objetivoFinal = objetivo === "perder" || objetivo === "ganhar" ? objetivo : "manter";
    const temIngredientes = Boolean(ingredientesDisponiveis && ingredientesDisponiveis.trim().length > 0);

    const { bmr, tdee, calorias: caloriasBase } = calcularCalorias({
      pesoAtual: Number(pesoAtual),
      alturaCm: Number(alturaCm),
      idade: Number(idade),
      sexo,
      nivelAtividade,
      objetivo: objetivoFinal,
    });

    const { calorias, ajusteAplicado } = avaliarProgresso(cicloAnterior, caloriasBase, objetivoFinal);
    const objetivoTexto = OBJETIVO_TEXTO[objetivoFinal];

    const userMessage = temIngredientes
      ? `Monte os 3 cardápios-modelo pedidos, com cerca de ${calorias} kcal por dia em cada um.
Ingredientes que a pessoa já tem em casa: ${ingredientesDisponiveis}.
Responda no formato JSON pedido.`
      : `Monte os 3 cardápios-modelo pedidos, com cerca de ${calorias} kcal por dia em cada um.
A pessoa não tem ingredientes específicos em mente. Responda no formato JSON pedido.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4500,
        system: buildSystemPrompt(calorias, objetivoTexto, temIngredientes),
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Erro Anthropic:", response.status, errText);
      return res.status(502).json({
        error: "falha ao consultar a IA",
        detalhe: `status ${response.status}: ${errText}`.slice(0, 300),
      });
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const rawText = textBlock ? textBlock.text : "{}";

    let bruto, foiReparado;
    try {
      const resultado = repairAndParseJSON(rawText);
      bruto = resultado.parsed;
      foiReparado = resultado.reparado;
      if (foiReparado) {
        console.warn("Resposta da IA veio cortada (bateu no limite de tamanho) — usei uma versão reparada/parcial.");
      }
    } catch (e) {
      console.error("Não foi possível interpretar a resposta da IA:", rawText);
      return res.status(502).json({
        error: "resposta da IA em formato inesperado",
        detalhe: "A resposta ficou grande demais e foi cortada no meio. Tente gerar de novo.",
        raw: rawText.slice(0, 500),
      });
    }

    // transforma os 3 cardápios-modelo em 7 dias (segunda a domingo), alternando-os
    const plano = {
      titulo: bruto.titulo || "Plano gerado",
      resumo: bruto.resumo || "",
      dias: montarSemanaAPartirDasVariacoes(bruto.variacoes),
    };

    return res.status(200).json({
      bmr,
      tdee,
      caloriasCalculadas: calorias,
      ajusteAplicado,
      plano,
      avisoTruncado: foiReparado || false,
    });
  } catch (err) {
    console.error("Erro ao gerar plano:", err);
    return res.status(500).json({
      error: "erro interno ao gerar o plano",
      detalhe: String(err && err.message ? err.message : err).slice(0, 300),
    });
  }
};

// dá mais tempo pra Vercel não matar a função antes da Claude terminar de
// gerar o cardápio de 7 dias. No plano Hobby da Vercel o máximo permitido é 60s.
module.exports.config = { maxDuration: 60 };
