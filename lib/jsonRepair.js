// A Claude às vezes devolve uma resposta cortada no meio (por exemplo, quando
// bate no limite de max_tokens antes de terminar um cardápio de 7 dias).
// Isso quebra o JSON.parse normal. Esta função tenta primeiro o parse normal
// e, se falhar, tenta "fechar" as chaves/colchetes que ficaram abertos e
// recuperar o que der (perdendo só o último item incompleto), em vez de
// falhar tudo.
function repairAndParseJSON(rawText) {
  const cleaned = String(rawText || "")
    .replace(/```json|```/g, "")
    .trim();

  try {
    return { parsed: JSON.parse(cleaned), reparado: false };
  } catch (e) {
    const reparado = tentarReparar(cleaned);
    if (reparado !== undefined) {
      return { parsed: reparado, reparado: true };
    }
    throw e;
  }
}

function tentarReparar(s) {
  // encontra o último ponto em que um objeto/array foi fechado por completo,
  // ignorando chaves/colchetes que estejam dentro de strings
  let inStr = false;
  let esc = false;
  let lastSafeIndex = -1;
  const stackFull = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stackFull.push(ch);
    else if (ch === "}" || ch === "]") {
      stackFull.pop();
      lastSafeIndex = i;
    }
  }

  if (lastSafeIndex === -1) return undefined;

  // recalcula quais chaves/colchetes ainda estavam abertos até aquele ponto
  const stackAtCut = [];
  inStr = false;
  esc = false;
  for (let i = 0; i <= lastSafeIndex; i++) {
    const ch = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stackAtCut.push(ch);
    else if (ch === "}" || ch === "]") stackAtCut.pop();
  }

  const truncated = s.slice(0, lastSafeIndex + 1).replace(/,\s*$/, "");
  let closing = "";
  for (let i = stackAtCut.length - 1; i >= 0; i--) {
    closing += stackAtCut[i] === "{" ? "}" : "]";
  }

  try {
    return JSON.parse(truncated + closing);
  } catch (e2) {
    return undefined;
  }
}

module.exports = { repairAndParseJSON };
