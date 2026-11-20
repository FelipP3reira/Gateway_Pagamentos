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
