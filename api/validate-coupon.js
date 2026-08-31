const { getAuthedUser } = require("../lib/firebaseAdmin");
const { buscarCupomValido, precoComDesconto } = require("../lib/coupons");

const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE || 70);

// Só confere se o cupom é válido e devolve o preço com desconto, pra mostrar
// na tela ANTES da pessoa pagar. O desconto de verdade é recalculado de novo
// (com o mesmo código) na hora de criar o pagamento — nunca confiamos no
// preço que volta daqui pra cobrar ninguém.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "método não permitido" });
  }

  const user = await getAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: "não autenticado" });
  }

  const { codigo } = req.body || {};
  const cupom = await buscarCupomValido(codigo);

  if (!cupom) {
    return res.status(404).json({ valido: false, error: "Cupom inválido, expirado ou esgotado." });
  }

  const precoFinal = precoComDesconto(MONTHLY_PRICE, cupom);

  return res.status(200).json({
    valido: true,
    codigo: cupom.codigo,
    tipo: cupom.tipo,
    valor: cupom.valor,
    precoOriginal: MONTHLY_PRICE,
    precoFinal,
  });
};
