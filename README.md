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

## Decisões

_(preenchido ao longo dos blocos)_

## Estado

Em construção, por blocos:

- [x] Bootstrap: Fastify, Kysely, Docker, migração, esquema e envelope de erro
- [ ] Máquina de estados com transições válidas explícitas
- [ ] Provedores (interface + Stripe + fake) e verificação de assinatura
- [ ] Serviço de pagamento, idempotência e webhooks
- [ ] Reconciliação e README final

## Escopo: o que fica de fora

_(detalhado no README final: PCI-DSS/SAQ, não-armazenamento de PAN, TLS,
gestão e rotação de chaves, 3-D Secure, retry de webhook, auditoria imutável…)_
