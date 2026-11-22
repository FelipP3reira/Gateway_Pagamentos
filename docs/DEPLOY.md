# Deploy do gateway

Destino padrão: **Railway** (serviço Docker + Postgres próprio). Alternativa
pronta: Render (`render.yaml`). Fly também roda a mesma imagem.

O gateway sobe a partir do `Dockerfile`. A imagem roda a migração (idempotente)
e depois o servidor. Se a migração falhar, o deploy novo não sobe e o anterior
continua no ar.

## 1. Railway (recomendado)

1. **Projeto**: New Project → Deploy from GitHub repo → `Gateway_Pagamentos`.
   O `railway.json` já define build pelo Dockerfile, health check em `/saude` e
   reinício em falha.
2. **Banco**: no mesmo projeto, + New → Database → PostgreSQL. No serviço do
   gateway, crie a variável `DATABASE_URL` referenciando o banco
   (`${{Postgres.DATABASE_URL}}`). Use a URL **interna** (rede privada, sem
   SSL e sem custo de tráfego).
3. **Variáveis** (Settings → Variables). Valores reais nunca entram no repositório:

   | Variável                       | Valor                                               |
   | ------------------------------ | --------------------------------------------------- |
   | `AMBIENTE`                     | `producao` (já vem da imagem)                       |
   | `GATEWAY_API_KEY`              | `openssl rand -hex 32` — a mesma na Vercel da loja  |
   | `LOJA_URL`                     | `https://<domínio da loja>`                         |
   | `LOJA_WEBHOOK_SECRET`          | `openssl rand -hex 32` — o mesmo na Vercel da loja  |
   | `MERCADOPAGO_ACCESS_TOKEN`     | Access Token (teste no staging, produção no prod)   |
   | `MERCADOPAGO_WEBHOOK_SECRET`   | Assinatura secreta do webhook (painel do MP)        |
   | `MERCADOPAGO_URL_NOTIFICACAO`  | `https://<domínio do gateway>/webhooks/mercadopago` |
   | `MERCADOPAGO_PARCELAS_MAXIMAS` | `12` (ou o que o contrato permitir)                 |
   | `NIVEL_LOG`                    | `info`                                              |

   `PORT` é injetada pela Railway; o gateway a usa quando `PORTA` não existe.
   `CONFIAR_NO_PROXY=true` já vem da imagem (IP real para o rate limit).

4. **Domínio**: Settings → Networking → Generate Domain (ou domínio próprio,
   ex. `pagamentos.pandimjoias.com.br`). Só HTTPS.
5. **Conferir**: `curl https://<gateway>/saude` → `{"status":"ok","ambiente":"producao"}` (503 se o banco cair).

## 2. Mercado Pago

1. Em **Suas integrações → sua aplicação → Webhooks**, cadastre
   `https://<gateway>/webhooks/mercadopago`, evento **Pagamentos**, e copie a
   **assinatura secreta** para `MERCADOPAGO_WEBHOOK_SECRET`.
2. Credenciais: **teste** no ambiente de staging/Preview; **produção** só no
   gateway de produção. Nunca misture.
3. A **Public Key** vai para a loja (`NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY`), nunca
   o Access Token.

## 3. Teste de ponta a ponta em sandbox

Com o gateway publicado usando credenciais de **teste**:

```bash
cat > .env.sandbox <<'VARS'
GATEWAY_URL=https://<gateway>
GATEWAY_API_KEY=<a chave>
MERCADOPAGO_PUBLIC_KEY=TEST-...
PAGADOR_EMAIL=<e-mail de um usuário de teste do MP>
VARS
npm run teste:sandbox
```

O script (`scripts/teste-sandbox.ts`) só fala HTTP, como a loja, e confere:
saúde e chave obrigatória; cartão aprovado em 3x (titular `APRO`);
idempotência; consulta por referência; reconciliação; estorno; cartão recusado
(`OTHE`); Pix com QR e copia e cola, cancelado em seguida; e, com `LOJA_URL`
configurada, a notificação assinada entregue à loja. Ele se recusa a rodar com
chave pública que não seja `TEST-`.

Depois, faça uma compra real pela loja em Preview (cartão de teste e Pix) e
confira o pedido pago no painel.

## 4. Operação

- **Rotação da chave da loja**: coloque a nova em `GATEWAY_API_KEY` e a antiga
  em `GATEWAY_API_KEY_ANTERIOR`; troque na Vercel; depois remova a anterior.
- **Notificações para a loja**: `GET /notificacoes?status=falhou` lista as que
  esgotaram as tentativas; `POST /notificacoes/:id/reenviar` reenvia.
- **Backup**: ative os backups do Postgres na Railway (ou `pg_dump` agendado).
  O gateway guarda só token e metadados — nenhum número de cartão ou CVV.
- **Rollback**: Deployments → deploy anterior → Redeploy. As migrações são só
  aditivas, então o código anterior roda no banco novo.
- **Escala**: uma réplica basta. Mais de uma é seguro (a fila de notificações
  usa `FOR UPDATE SKIP LOCKED`), mas não é necessário no volume da loja.

## 5. Render (alternativa)

New → Blueprint → este repositório. O `render.yaml` cria o serviço Docker e o
Postgres 16; preencha os segredos marcados `sync: false` no painel. O resto é
igual (webhook do MP, teste de sandbox).
