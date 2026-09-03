const { buscarCupomDestaqueLanding, precoComDesconto } = require("../lib/coupons");

const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE || 70);

// Endpoint PÚBLICO (sem login) — a página chama isso assim que carrega pra
// saber se tem algum cupom marcado como "automático pós-cadastro". O preço
// calculado aqui NÃO é mostrado na página de vendas (nenhum preço aparece
// lá) — ele só é usado depois, na tela de assinatura, pra já vir o cupom
// aplicado sozinho quando a pessoa termina de criar a conta. Só devolve o
// que já é pra ser público mesmo (o código do cupom e o preço calculado) —
// nunca a lista inteira de cupons.
module.exports = async (req, res) => {
  try {
    const cupom = await buscarCupomDestaqueLanding();
    if (!cupom) {
      return res.status(200).json({ ativo: false });
    }

    const precoFinal = precoComDesconto(MONTHLY_PRICE, cupom);

    return res.status(200).json({
      ativo: true,
      codigo: cupom.codigo,
      tipo: cupom.tipo,
      valor: cupom.valor,
      precoOriginal: MONTHLY_PRICE,
      precoFinal,
    });
  } catch (err) {
    console.error("Erro ao buscar cupom em destaque:", err);
    // em caso de erro, a página de vendas simplesmente mostra o preço cheio
    return res.status(200).json({ ativo: false });
  }
};
