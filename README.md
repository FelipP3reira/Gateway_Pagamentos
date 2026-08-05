# Gateway de Pagamentos

Camada de gateway que abstrai provedores de pagamento (**Stripe** e um **provider
fake** próprio) atrás de uma interface comum, com máquina de estados, webhooks
com assinatura verificada e idempotência à prova de cobrança dupla.

> ⚠️ **Sandbox — sem dinheiro real.** Este projeto roda apenas em modo de teste
> (Stripe test mode + provider fake). Não processa pagamentos reais e **não é**,
> por si só, um sistema PCI-compliant de produção. Veja
> [Escopo e PCI](#escopo-o-que-fica-de-fora) no fim.

## Stack

- **Node + TypeScript** (ESM, modo estrito) + **Fastify**
- **PostgreSQL** com **Kysely** (SQL tipado, sem ORM)
- **Stripe SDK** (modo teste) + provider fake com HMAC próprio
- **Vitest** para os testes (integração contra o Postgres)

## Como rodar

```bash
cp .env.example .env
docker compose up -d          # Postgres na 5440
npm install
npm run migrar
npm run dev                   # servidor em http://localhost:3011
```

```bash
npm test                      # suíte contra o banco pagamentos_teste
```

O `docker compose up` cria o banco `pagamentos_teste` junto com o de trabalho.
Os testes rodam contra ele, para nunca tocar nos dados de desenvolvimento.

A Stripe é opcional: sem `STRIPE_SECRET_KEY`, o adaptador fica desligado e o
provider fake cobre o fluxo. A suíte não depende de rede nem de chave real.

## API

| Método | Rota                          | O que faz                                   |
| ------ | ----------------------------- | ------------------------------------------- |
| POST   | `/pagamentos`                 | Cria a cobrança (header `Idempotency-Key`). |
| POST   | `/pagamentos/:id/capturar`    | Captura o valor autorizado.                 |
| POST   | `/pagamentos/:id/estornar`    | Estorna o pagamento capturado.              |
| POST   | `/pagamentos/:id/cancelar`    | Cancela antes da captura.                   |
| POST   | `/pagamentos/:id/reconciliar` | Alinha o estado local com o do provedor.    |
| GET    | `/pagamentos/:id`             | Consulta o pagamento.                       |
| POST   | `/webhooks/:provedor`         | Recebe eventos (assinatura obrigatória).    |
| POST   | `/pix/chaves`                 | Gera/registra uma chave PIX (sandbox).      |
| POST   | `/pix/cobrancas`              | Cria a cobrança PIX: copia-e-cola + QR.     |
| POST   | `/webhooks/pix`               | Confirma o pagamento PIX (assinado).        |

O corpo de `POST /pagamentos` recebe `provedor`, `valorCentavos` (inteiro),
`moeda`, `tokenMetodo` (o **token do provedor**, nunca o cartão) e
`capturaAutomatica`.

`POST /pix/cobrancas` (com `Idempotency-Key`) recebe `chave` e `valorCentavos` e
devolve o **copia-e-cola** e o **QR** (SVG + PNG data URI). O pagamento nasce
`pendente` e é liquidado quando chega o webhook de confirmação assinado.

## Decisões

**Idempotência em duas camadas.** A criação usa `Idempotency-Key` com uma
constraint única no banco: a mesma chave nunca gera dois pagamentos, e uma
requisição repetida devolve o pagamento existente **sem chamar o provedor de
novo**. Os webhooks têm sua própria camada — cada evento é reivindicado por
`(provedor, evento_id)` único antes de qualquer efeito; um webhook duplicado
vira no-op. É o requisito crítico: webhook repetido **não captura duas vezes**.

**Máquina de estados com transições explícitas.** `pendente → autorizado →
capturado → estornado`, com `falhou`/`cancelado`. A ausência de uma aresta é
proibição — capturar um pagamento já capturado, ou pular a autorização, é
rejeitado com 409. Cada mudança é gravada num log de auditoria, e a transição
roda numa transação com trava de linha (`FOR UPDATE`), então duas operações
concorrentes serializam em vez de cobrar em dobro.

**Provedores atrás de uma interface.** `autorizar`, `capturar`, `estornar`,
`cancelar`, `consultar`, `verificarWebhook` — o serviço nunca conhece o provedor
concreto. Adicionar um provedor é escrever um adaptador e registrá-lo. O cliente
da Stripe é injetado, o que deixa o adaptador testável sem rede.

**Assinatura de webhook obrigatória.** Sem assinatura válida, o evento não
existe: 401 e nada roda. A Stripe verifica com `constructEvent` sobre o corpo
cru; o fake usa HMAC-SHA256 com **comparação em tempo constante**. O servidor
guarda o corpo cru justamente para a assinatura conferir byte a byte.

**Reconciliação com o provedor como fonte da verdade.** Se um webhook se perde,
`/reconciliar` consulta o estado no provedor e avança o local até alcançá-lo —
sempre por uma transição válida. Uma divergência que a máquina de estados não
aceita não é "consertada" às escondidas: fica visível.

**PCI por design (tokenização).** A API **nunca** recebe número de cartão (PAN):
só o token do método de pagamento gerado pelo provedor. Segredos, tokens e
assinaturas são redigidos antes de qualquer log; o PAN não entra no sistema, e
se cair num objeto por engano, a máscara pega.

**PIX: o QR é real, a liquidação é simulada.** O BR Code ("copia e cola") é
gerado conforme o padrão EMV/Banco Central — formatação TLV fechada por
CRC16-CCITT —, então um app de banco leria o payload. O que é sandbox: a **chave
PIX** é simulada (uma aleatória é só um UUID, não registrada no DICT, e por isso
não recebe dinheiro real) e a **confirmação** vem de um webhook assinado de
teste, não de um PSP. A cobrança PIX reaproveita a mesma máquina de estados e a
mesma idempotência de webhook do resto do gateway (evento duplicado não liquida
duas vezes).

**Config falha na subida.** Falta de `DATABASE_URL` ou `FAKE_WEBHOOK_SECRET`
derruba o processo no boot, não na primeira requisição.

## Escopo: o que fica de fora

Isto é um estudo de arquitetura em **sandbox**. Um gateway de produção de
verdade exigiria, além do que está aqui:

- **PCI-DSS / SAQ**: mesmo tokenizando, o ambiente precisaria de avaliação de
  conformidade, escopo reduzido e evidências. Aqui não há nenhuma.
- **TLS obrigatório** ponta a ponta e HSTS — este projeto sobe em HTTP local.
- **Nunca armazenar PAN/CVV**; usar apenas tokens e, se preciso, um cofre
  certificado. Nós já não armazenamos, mas sem as garantias formais.
- **Gestão e rotação de chaves/segredos** (KMS/secret manager), não `.env`.
- **3-D Secure / SCA** e o fluxo de autenticação do portador.
- **Retry e fila de webhooks** com backoff e ordenação — aqui o processamento é
  síncrono e idempotente, mas sem re-entrega própria.
- **Auditoria imutável** (append-only assinado) e retenção/observabilidade.
- **Antifraude, limites, chargebacks e disputas**, reconciliação financeira
  contábil (não só de estado).
- **PIX de verdade**: registrar a chave no **DICT** do Banco Central via um PSP
  licenciado, integração com a API PIX (mTLS, certificados, homologação),
  cobrança dinâmica (payload com URL do PSP) e devolução (`/pix/devolucoes`).
  Aqui a chave é simulada e a liquidação vem de um webhook de sandbox.

## Estado

- [x] Bootstrap: Fastify, Kysely, Docker, migração, esquema e envelope de erro
- [x] Máquina de estados com transições válidas explícitas
- [x] Provedores (interface + Stripe + fake) e verificação de assinatura
- [x] Serviço de pagamento, idempotência e webhooks
- [x] Reconciliação e README final
- [x] PIX (sandbox): chave, cobrança com BR Code + QR e confirmação por webhook
