const { admin, db } = require("./firebaseAdmin");

// Preço por milhão de tokens da Claude, em dólar (padrão da família Sonnet).
// Ajuste aqui (ou pelas variáveis de ambiente da Vercel) se a Anthropic mudar
// os preços do modelo usado — veja a variável MODEL nos outros arquivos.
const PRECO_INPUT_USD_MI = Number(process.env.PRECO_INPUT_USD_MI || 3.0);
const PRECO_OUTPUT_USD_MI = Number(process.env.PRECO_OUTPUT_USD_MI || 15.0);

// Cotação dólar → real usada só pra converter o custo da IA (a Anthropic
// cobra em dólar). Não buscamos uma cotação em tempo real — ajuste esse valor
// de vez em quando pela variável de ambiente USD_BRL_RATE na Vercel.
const USD_BRL = Number(process.env.USD_BRL_RATE || 5.5);

// Orçamento mensal de IA incluso na assinatura, em reais.
const ORCAMENTO_MENSAL_BRL = Number(process.env.ORCAMENTO_MENSAL_BRL || 25);

// Quantos créditos cada pacote de R$10 de compra avulsa libera.
const CREDITOS_POR_PACOTE = Number(process.env.CREDITOS_POR_PACOTE || 10);
const PRECO_PACOTE_BRL = Number(process.env.PRECO_PACOTE_BRL || 10);

// Calcula, em reais, quanto uma resposta da Claude custou de verdade, com
// base na contagem real de tokens que a própria Anthropic devolve em toda
// resposta (campo "usage").
function custoBRL(usage) {
  const inputTokens = (usage && usage.input_tokens) || 0;
  const outputTokens = (usage && usage.output_tokens) || 0;
  const custoUsd = (inputTokens / 1e6) * PRECO_INPUT_USD_MI + (outputTokens / 1e6) * PRECO_OUTPUT_USD_MI;
  return custoUsd * USD_BRL;
}

// Só usa a IA quem tem assinatura paga ativa, quem é admin (sua própria conta),
// ou quem você liberou manualmente um teste grátis pelo painel (campo
// "trialGrantedByAdmin" — só você consegue mudar esse campo, é protegido nas
// regras do Firestore). Sem isso, ninguém usa nenhum recurso de IA de graça.
function temAssinaturaOuTeste(d) {
  if (d.role === "admin" || d.trialGrantedByAdmin === true) return true;
  if (d.subscriptionStatus !== "active") return false;

  // Assinatura paga de forma "manual" (ex.: Pix avulso, sem renovação
  // automática no Mercado Pago) tem prazo de validade guardado em
  // "subscriptionExpiresAt" — passado esse prazo sem um novo pagamento,
  // tratamos como se não tivesse mais assinatura ativa, mesmo que o campo
  // "subscriptionStatus" ainda esteja em "active" (só o webhook de um novo
  // pagamento aprovado, ou você manualmente, muda esse campo de volta).
  if (d.subscriptionPaymentMethod === "manual" && d.subscriptionExpiresAt) {
    const expiraEm = d.subscriptionExpiresAt.toDate
      ? d.subscriptionExpiresAt.toDate()
      : new Date(d.subscriptionExpiresAt);
    if (expiraEm.getTime() < Date.now()) return false;
  }

  return true;
}

// Verifica se o usuário pode usar a IA agora: primeiro se tem assinatura/teste
// liberado, depois se ainda tem saldo — orçamento mensal (R$) OU créditos
// avulsos. Não debita nada ainda, só checa. Chame isso ANTES de consultar a Claude.
async function verificarSaldo(uid) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const d = snap.exists ? snap.data() || {} : {};
  const gasto = d.budgetSpentBRL || 0;
  const creditos = d.extraCredits || 0;
  const assinaturaOk = temAssinaturaOuTeste(d);
  const dentroDoOrcamento = gasto < ORCAMENTO_MENSAL_BRL;

  return {
    assinaturaOk,
    podeUsar: assinaturaOk && (dentroDoOrcamento || creditos > 0),
    usaraCredito: !dentroDoOrcamento,
    gasto,
    creditos,
    ref,
  };
}

// Debita o custo real depois de uma chamada à Claude bem-sucedida. Se o
// usuário já tinha estourado o orçamento mensal, desconta 1 crédito avulso
// em vez de (ou além de) somar ao gasto do mês.
async function registrarGasto(ref, usage, usaraCredito) {
  const custo = custoBRL(usage);
  const updates = { budgetSpentBRL: admin.firestore.FieldValue.increment(custo) };
  if (usaraCredito) {
    updates.extraCredits = admin.firestore.FieldValue.increment(-1);
  }
  await ref.set(updates, { merge: true });
  return custo;
}

module.exports = {
  custoBRL,
  verificarSaldo,
  registrarGasto,
  ORCAMENTO_MENSAL_BRL,
  CREDITOS_POR_PACOTE,
  PRECO_PACOTE_BRL,
};
