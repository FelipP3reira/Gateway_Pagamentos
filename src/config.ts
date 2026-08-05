// Config validada no import: falta de variável essencial derruba o processo no
// boot, não na primeira requisição. Errar cedo é mais barato.

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) {
    throw new Error(`Variável de ambiente ausente: ${nome}`);
  }
  return valor;
}

function opcional(nome: string): string | undefined {
  const valor = process.env[nome];
  return valor && valor.length > 0 ? valor : undefined;
}

export const config = {
  ambiente: process.env.AMBIENTE ?? 'desenvolvimento',
  porta: Number(process.env.PORTA ?? 3011),
  databaseUrl: obrigatoria('DATABASE_URL'),
  // Segredo do provider fake (HMAC dos webhooks). Obrigatório: sem ele não há
  // como verificar assinatura, e webhook sem verificação é porta aberta.
  fakeWebhookSecret: obrigatoria('FAKE_WEBHOOK_SECRET'),
  // Stripe é opcional: sem as chaves, o adaptador fica desligado.
  stripeSecretKey: opcional('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: opcional('STRIPE_WEBHOOK_SECRET'),
} as const;

export type Config = typeof config;
