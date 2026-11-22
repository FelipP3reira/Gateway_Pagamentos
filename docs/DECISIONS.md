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

## G4 — Adaptador Mercado Pago

**API de pagamentos v1 (Checkout Transparente), não a de Orders.** A loja
tokeniza o cartão com o SDK/Bricks e o gateway cria o pagamento em
`POST /v1/payments`; o Pix usa o mesmo endpoint com `payment_method_id: "pix"`.
É o fluxo que casa com a interface `autorizar/capturar/estornar/cancelar`.

**Cliente HTTP próprio e injetado, sem o SDK do Mercado Pago.** Como no Stripe,
o adaptador recebe o cliente no construtor e os testes passam um Mercado Pago em
memória. São cinco chamadas REST; o SDK seria uma dependência a mais.

**Assinatura do webhook copiada do validador oficial.** A página de webhooks
não publica o manifest; a fonte verificável é o validador do SDK Node oficial
(`mercadopago/sdk-nodejs`, `src/utils/webhook`) e os testes dele: manifest
`id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com pares ausentes omitidos,
`data.id` da query sem alterar maiúsculas, HMAC-SHA256 em hex na versão `v1`,
comparação em tempo constante. A janela de 300 s contra replay segue o exemplo
da documentação do SDK; o `ts` é tratado como segundos, aceitando também
milissegundos para a janela não rejeitar tudo se o formato mudar.

**O provedor pode reportar `pendente`.** Pix aguardando transferência e cartão
em análise (`in_process`) deixam o pagamento pendente até o webhook ou a
reconciliação. Antes o serviço sempre levava para `autorizado`.

**Avanço por caminho, não por salto.** Um evento pode reportar um estado dois
passos à frente (Pix pago: `pendente` → aprovado). `caminhoAte` calcula o menor
caminho válido e `avancar` aplica todos os passos numa transação, com a linha
travada e uma linha de auditoria por passo. Sem caminho válido, nada muda —
como antes, divergência real não é "consertada" às escondidas.

**Consultar antes de reivindicar o evento.** A notificação do Mercado Pago traz
só o id; o estado vem de `GET /v1/payments/{id}`. A consulta acontece antes do
claim em `webhook_eventos`: se falhar, o webhook responde 502 e o reenvio do
Mercado Pago é processado normalmente. Notificação de pagamento que não é nosso
não gera consulta.

**Recusa definitiva ≠ falha transitória.** 4xx de validação na criação (token
inválido, dados recusados) viram `falhou`: a cobrança não existe lá. 401, 403,
429 e 5xx são configuração ou instabilidade: `502` e `pendente`, para a
reconciliação resolver.

**Pix devolvido pelo provedor fica em colunas do pagamento.** Copia e cola, QR
(PNG base64), URL do ticket e validade ficam em `pagamentos`, para a loja
reler no polling (`GET /pagamentos/:id`). O Pix simulado continua em
`cobrancas_pix`. Se o Mercado Pago não devolver o QR, a referência é guardada
mesmo assim (a cobrança existe lá) e a resposta traz `pix: null`.

**Validade do Pix: 30 minutos por padrão, de 30 min a 30 dias.** Limites da
documentação do Pix; o padrão casa com a reserva de estoque da loja. A data vai
no fuso de Brasília (`-03:00`).

**Estorno integral com chave fixa por pagamento.** `POST .../refunds` sem
`amount` (integral) e `X-Idempotency-Key: estorno-<id>`: um retry nunca estorna
duas vezes. Captura e cancelamento seguem a mesma ideia. Estorno parcial fica no
backlog.

**Fake também cobra Pix.** Para o E2E de Pix da loja rodar sem provedor: QR e
copia e cola válidos de uma chave de teste, liquidados pelo webhook assinado do
fake.
