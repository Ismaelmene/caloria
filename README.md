# Calorias por Foto — app + painel afiliado + painel admin

Stack: `index.html` (front-end único, com Firebase no navegador) + funções serverless
na Vercel (`/api`) + Firebase (login e banco de dados) + Mercado Pago (assinatura
recorrente) + Claude (análise da foto do prato).

## Como tudo se conecta

1. A pessoa se cadastra (e-mail/senha) direto no `index.html`, usando o Firebase Auth.
2. Se ela entrou por um link de indicação (`?ref=CODIGO`), isso é gravado no cadastro dela.
3. Ela tira a foto do prato → o navegador manda pra função `/api/analyze-photo`, que
   chama a API da Claude com um prompt calibrado pra comida brasileira (usa a TACO
   como referência) e devolve calorias/macros.
4. Para continuar usando sem limite, ela assina via `/api/create-checkout`, que cria
   uma assinatura no Mercado Pago e manda ela pro checkout oficial deles (o app nunca
   vê o número do cartão — isso evita você ter que lidar com PCI-DSS).
5. Todo mês, quando o Mercado Pago cobra a renovação, ele avisa sua função
   `/api/mp-webhook`, que: (a) mantém o acesso da pessoa ativo, e (b) se ela veio de
   um afiliado, credita a comissão recorrente automaticamente na coleção `commissions`.
6. O painel do afiliado e o painel admin só leem esses dados direto do Firestore
   (usando as regras de segurança em `firestore.rules`), sem precisar de mais nenhuma
   função no servidor.

## Passo 1 — Criar o projeto no Firebase

1. Acesse console.firebase.google.com → "Adicionar projeto".
2. Ative **Authentication** → método "E-mail/senha".
3. Ative **Firestore Database** (modo produção).
4. Em "Configurações do projeto" → "Seus apps" → crie um app Web e copie o objeto
   `firebaseConfig`. Cole esses valores no início do `<script type="module">` dentro
   do `index.html` (procure por `COLE_AQUI`). Esses dados não são secretos, podem
   ficar no código.
5. Em "Configurações do projeto" → "Contas de serviço" → "Gerar nova chave privada".
   Isso baixa um JSON — você vai colar o conteúdo inteiro na variável de ambiente
   `FIREBASE_SERVICE_ACCOUNT` (ver Passo 4). Esse arquivo é secreto, nunca suba pro
   GitHub.
6. Instale a CLI do Firebase (`npm install -g firebase-tools`) e publique as regras
   de segurança do projeto:
   ```bash
   firebase login
   firebase init firestore   # aponte para o projeto que você criou
   firebase deploy --only firestore:rules
   ```
   (o arquivo `firestore.rules` já vem pronto neste projeto)

## Passo 2 — Criar conta no Mercado Pago Developers

1. Acesse mercadopago.com.br/developers, crie uma aplicação.
2. Pegue o **Access Token** (use o de teste primeiro, depois troque pelo de produção).
3. Configure o webhook: em "Notificações" (Webhooks), cadastre a URL:
   `https://SEU-PROJETO.vercel.app/api/mp-webhook?token=SEU_MP_WEBHOOK_SECRET`
   (o `SEU_MP_WEBHOOK_SECRET` é uma senha que você inventa e também coloca na
   variável de ambiente `MP_WEBHOOK_SECRET` — é uma proteção extra nossa).
4. **Importante:** teste todo o fluxo de assinatura no ambiente de teste (sandbox) do
   Mercado Pago antes de usar credenciais de produção — assinatura recorrente envolve
   dinheiro de verdade e vale garantir que os webhooks estão funcionando certinho.

## Passo 3 — Criar a chave da Claude (Anthropic)

1. Acesse platform.claude.com (ou console.anthropic.com), crie uma API key.
2. Confirme no site qual é o nome do modelo com visão mais atual (o padrão aqui é
   `claude-sonnet-4-5`, mas isso pode mudar — vale checar antes de ir pra produção).

## Passo 4 — Subir no GitHub e publicar na Vercel

```bash
cd calorias-app
git init
git add .
git commit -m "primeiro commit"
git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git
git branch -M main
git push -u origin main
```

Na Vercel: "Add New" → "Project" → selecione o repositório. Antes do deploy, configure
as variáveis de ambiente (Settings → Environment Variables):

- `ANTHROPIC_API_KEY`
- `CLAUDE_MODEL` (opcional, tem valor padrão)
- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET`
- `FIREBASE_SERVICE_ACCOUNT` (o JSON da conta de serviço, em uma linha só)
- `PUBLIC_BASE_URL` (a URL que a Vercel vai te dar, ex: `https://calorias-app.vercel.app`)
- `ADMIN_BOOTSTRAP_SECRET` (uma senha só sua, pra virar o primeiro admin)
- `DEFAULT_COMMISSION_RATE` (ex: `0.30` — você disse que ainda vai definir esse número)
- `MONTHLY_PRICE` (valor da mensalidade, ex: `29.9`)

Clique em Deploy.

## Passo 5 — Virar admin (você)

1. Acesse seu app publicado, crie sua conta normalmente (cadastro comum).
2. Pegue o seu UID: Firebase Console → Authentication → sua conta → copie o "User UID".
3. Rode este comando no terminal (ou use um cliente HTTP como Insomnia/Postman),
   substituindo os valores:

   ```bash
   curl -X POST https://SEU-PROJETO.vercel.app/api/promote-role \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer SEU_ID_TOKEN_DO_FIREBASE" \
     -H "x-bootstrap-secret: SEU_ADMIN_BOOTSTRAP_SECRET" \
     -d '{"targetUid":"SEU_UID","role":"admin"}'
   ```

   Para pegar o "ID token", a forma mais fácil é abrir o console do navegador (F12)
   enquanto está logado no app e rodar:
   ```js
   await firebase.auth().currentUser.getIdToken()
   ```
   (como o projeto usa o SDK modular, alternativamente adicione um botão temporário
   no app que faça `console.log(await window._state.user.getIdToken())` — já existe
   `window._state.idToken` disponível no console depois de logar)

4. Depois de virar admin, faça login de novo (ou recarregue a página) — a aba
   "Painel admin" vai aparecer. Dali em diante, você promove qualquer outra pessoa a
   afiliado direto pela interface, sem precisar mexer em terminal de novo.

## Como funciona a comissão do afiliado

Cada afiliado tem uma `commissionRate` (ex: `0.30` = 30%) guardada no Firestore,
editável por você no painel admin (via `/api/promote-role`, informando a nova taxa).
Toda vez que o Mercado Pago confirma um pagamento de um usuário que foi indicado por
um afiliado, a função `/api/mp-webhook` calcula `valor_pago × commissionRate` e grava
um registro em `commissions`, além de somar ao `totalEarned` do afiliado. **Importante:**
este projeto registra a comissão automaticamente, mas o **pagamento em si para o
afiliado (transferência do dinheiro) você ainda precisa fazer manualmente** (Pix, por
exemplo) — o painel admin serve para você ver quanto deve a cada um; ainda não há
integração de saque automático.

## Limitações desta primeira versão (deixe claro antes de vender de verdade)

- A estimativa de calorias é feita por IA a partir de uma foto — não é uma medição
  exata. Vale ter um aviso no app de que é uma estimativa, não substitui orientação
  de nutricionista.
- O checkout do Mercado Pago aqui usa o formato de assinatura "sem plano associado",
  redirecionando a pessoa pro checkout oficial deles. Teste o fluxo completo (assinar,
  cancelar, falha de pagamento, renovação) no ambiente de sandbox antes de divulgar.
- A validação do webhook usa um token simples na URL. Para reforçar contra fraude,
  vale também validar o cabeçalho `x-signature` que o Mercado Pago envia, conforme a
  documentação oficial deles de webhooks.
- Pagamento de comissão ao afiliado é manual (ver acima).
