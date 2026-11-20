# Decisões

Registro curto das decisões tomadas onde o pedido era ambíguo. A mais recente
fica no fim.

## G2 — Autenticação entre serviços e operação

**Chave da API com rotação por duas variáveis.** `GATEWAY_API_KEY` (atual) e
`GATEWAY_API_KEY_ANTERIOR` (opcional, só durante a troca). Duas variáveis com
nome fixo são mais simples de operar no painel da plataforma do que uma lista
separada por vírgula. Rotação: põe a nova em `GATEWAY_API_KEY` e a velha em
`_ANTERIOR` → troca na loja → apaga `_ANTERIOR`.

**Comparação por SHA-256 + `timingSafeEqual`.** Comparar os resumos (tamanho
fixo) evita vazar o tamanho da chave, e a verificação percorre todas as chaves
aceitas sem sair cedo.

**API aberta fora de produção quando a chave está vazia.** Mantém o
desenvolvimento local e a suíte existente sem fricção; em produção o boot falha
sem a chave (e com chave de menos de 32 caracteres). Os testes de autenticação
injetam as chaves explicitamente.

**Fake e PIX simulado não existem em produção.** O segredo deles é de
desenvolvimento; registrados em produção, seriam um jeito de forjar um
pagamento aprovado com um webhook assinado por esse segredo. Com
`AMBIENTE=producao`, o provider fake não é registrado e as rotas `/pix/*` e
`/webhooks/pix` não sobem.

**Rate limit em memória, só nos webhooks.** `@fastify/rate-limit` com store em
memória, por IP (120/min configurável). O gateway roda em uma instância; se
escalar para várias, trocar o store por Redis. As rotas autenticadas não têm
limite próprio: só a loja tem a chave.

**Migração no start do contêiner.** `migrar.ts` é idempotente (`IF NOT EXISTS`);
o contêiner roda a migração e, se ela passar, faz `exec` do servidor. Se falhar,
o processo não sobe e a plataforma mantém o deploy anterior.

**Sem build: type stripping do Node, sem parameter properties.** O Node 26
removeu `--experimental-transform-types` (os scripts `dev`/`migrar` já não
rodavam nele). Em vez de travar a versão do Node ou adicionar um passo de
compilação, as _parameter properties_ (`constructor(private readonly x)`) viraram
campos explícitos e os scripts usam `--experimental-strip-types`, que roda no
Node 22.18+, 24 e 26. `erasableSyntaxOnly` no tsconfig impede a volta de sintaxe
que precise de transformação. A imagem usa Node 24 (LTS ativa).

**Provedor indisponível é barrado antes de gravar.** Antes, `POST /pagamentos`
com um provedor não registrado gravava o pagamento `pendente` e só então
respondia 400, deixando uma linha órfã. Agora o provedor é resolvido primeiro.

## G3 — Parcelas

**Teto na API, máximo por provedor, regra comercial na loja.** A API aceita de 1
a 24 parcelas; cada adaptador declara `parcelasMaximas` (fake 12, Stripe 1, já
que o adaptador de teste não implementa parcelamento). Juros, parcela mínima e
"sem juros até N" são regra comercial e ficam na loja; o gateway só garante que
o provedor consegue cobrar.

**Validação antes de gravar.** Como no provedor indisponível, parcelas acima do
máximo do provedor viram `400 parcelas_invalidas` sem criar pagamento.

**Pagador não é persistido.** O Mercado Pago exige e-mail e documento do
pagador. O gateway repassa ao provedor e não guarda: a loja é a dona do
cadastro, e dado pessoal que o gateway não usa é só risco (LGPD).

**Campos extras são descartados, não rejeitados.** É o padrão do Fastify
(`removeAdditional`) e já valia antes. O que não está no schema some antes da
rota, então nada fora do contrato chega ao provedor ou ao banco.

**Campos opcionais no domínio.** `parcelas` (padrão 1), `metodoPagamentoId`,
`emissorId` e `pagador` são opcionais em `NovaCobranca`, para não quebrar quem
já cria pagamentos (PIX simulado, testes). A migração usa `ADD COLUMN IF NOT
EXISTS` com padrão 1, então os pagamentos antigos ficam como à vista.
