const { db, admin } = require("./firebaseAdmin");

// Cupom de desconto: cada um vira um documento na coleção "coupons", com o
// próprio código (em maiúsculas) como id do documento. Só o painel admin
// cria/edita cupons (regra protegida no firestore.rules); a validação e o
// cálculo do preço com desconto sempre acontecem aqui no servidor — nunca
// confiamos num valor de desconto que venha do navegador da pessoa.

// Busca um cupom pelo código e devolve null se ele não existir, estiver
// desativado, tiver passado da validade, ou já tiver batido o limite de usos.
async function buscarCupomValido(codigo) {
  if (!codigo) return null;
  const code = String(codigo).trim().toUpperCase();
  if (!code) return null;

  const snap = await db.collection("coupons").doc(code).get();
  if (!snap.exists) return null;

  const c = snap.data() || {};
  if (c.ativo === false) return null;

  if (c.validoAte) {
    const validoAte = c.validoAte.toDate ? c.validoAte.toDate() : new Date(c.validoAte);
    if (validoAte.getTime() < Date.now()) return null;
  }

  if (typeof c.usosMax === "number" && c.usosMax > 0 && (c.usosAtuais || 0) >= c.usosMax) {
    return null;
  }

  return { codigo: code, tipo: c.tipo === "fixo" ? "fixo" : "percentual", valor: Number(c.valor) || 0 };
}

// Busca o cupom marcado como "automático pós-cadastro" (campo
// "mostrarNaLanding"), se ele ainda estiver válido — usado pelo endpoint
// público /api/featured-coupon, chamado assim que a página carrega (antes
// de a pessoa estar logada) só pra saber o código, e reaplicado sozinho na
// tela de assinatura depois que ela cria a conta. Não expõe nenhum preço na
// página de vendas. Só deve existir um cupom marcado assim por vez (o
// painel admin cuida de desmarcar os outros quando você ativa um novo), mas
// se por algum motivo houver mais de um, pegamos o primeiro que ainda for
// válido.
async function buscarCupomDestaqueLanding() {
  const snap = await db.collection("coupons").where("mostrarNaLanding", "==", true).limit(5).get();
  for (const docSnap of snap.docs) {
    const c = docSnap.data() || {};
    if (c.ativo === false) continue;

    if (c.validoAte) {
      const validoAte = c.validoAte.toDate ? c.validoAte.toDate() : new Date(c.validoAte);
      if (validoAte.getTime() < Date.now()) continue;
    }

    if (typeof c.usosMax === "number" && c.usosMax > 0 && (c.usosAtuais || 0) >= c.usosMax) {
      continue;
    }

    return { codigo: docSnap.id, tipo: c.tipo === "fixo" ? "fixo" : "percentual", valor: Number(c.valor) || 0 };
  }
  return null;
}

// Aplica o desconto do cupom num preço base, em reais. Nunca deixa o preço
// final passar de zero (protege contra cupom mal configurado e evita mandar
// um valor inválido pro Mercado Pago).
function precoComDesconto(precoBase, cupom) {
  if (!cupom) return precoBase;
  const preco =
    cupom.tipo === "fixo" ? precoBase - cupom.valor : precoBase * (1 - cupom.valor / 100);
  return Math.max(1, Number(preco.toFixed(2)));
}

// Soma +1 no contador de usos do cupom. Chame só depois de confirmar que o
// pagamento foi realmente aprovado (nunca no momento de só validar o código).
async function registrarUsoCupom(codigo) {
  if (!codigo) return;
  const code = String(codigo).trim().toUpperCase();
  if (!code) return;
  await db
    .collection("coupons")
    .doc(code)
    .set({ usosAtuais: admin.firestore.FieldValue.increment(1) }, { merge: true });
}

module.exports = { buscarCupomValido, precoComDesconto, registrarUsoCupom, buscarCupomDestaqueLanding };
