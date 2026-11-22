// Config validada no import: falta de variável essencial derruba o processo no
// boot, não na primeira requisição. Errar cedo é mais barato.
//
// `carregarConfig` é pura (recebe o env) para os testes exercitarem as regras de
// produção sem mexer no process.env do processo.

export type Ambiente = 'desenvolvimento' | 'teste' | 'producao';

type Env = Record<string, string | undefined>;

const AMBIENTES: readonly Ambiente[] = ['desenvolvimento', 'teste', 'producao'];

function obrigatoria(env: Env, nome: string): string {
  const valor = env[nome];
  if (!valor) {
    throw new Error(`Variável de ambiente ausente: ${nome}`);
  }
  return valor;
}

function opcional(env: Env, nome: string): string | undefined {
  const valor = env[nome];
  return valor && valor.length > 0 ? valor : undefined;
}

function inteiro(env: Env, nome: string, padrao: number): number {
  const valor = opcional(env, nome);
  if (valor === undefined) {
    return padrao;
  }
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new Error(`Variável de ambiente inválida: ${nome} deve ser inteiro positivo.`);
  }
  return numero;
}

// Chave mínima para a API entre serviços. 32 caracteres aleatórios já dão folga.
const TAMANHO_MINIMO_CHAVE = 32;

export function carregarConfig(env: Env = process.env) {
  const ambienteBruto = env.AMBIENTE ?? 'desenvolvimento';
  if (!AMBIENTES.includes(ambienteBruto as Ambiente)) {
    throw new Error(`AMBIENTE inválido: "${ambienteBruto}". Use ${AMBIENTES.join(', ')}.`);
  }
  const ambiente = ambienteBruto as Ambiente;
  const producao = ambiente === 'producao';

  // Chaves da API entre serviços. A anterior existe só para a rotação: durante a
  // troca as duas valem, depois a anterior é removida.
  const chavesApi = [
    opcional(env, 'GATEWAY_API_KEY'),
    opcional(env, 'GATEWAY_API_KEY_ANTERIOR'),
  ].filter((chave): chave is string => chave !== undefined);

  if (producao && !opcional(env, 'GATEWAY_API_KEY')) {
    throw new Error('Variável de ambiente ausente: GATEWAY_API_KEY (obrigatória em produção).');
  }
  if (producao && chavesApi.some((chave) => chave.length < TAMANHO_MINIMO_CHAVE)) {
    throw new Error(
      `GATEWAY_API_KEY fraca: use ao menos ${TAMANHO_MINIMO_CHAVE} caracteres em produção.`,
    );
  }

  // Notificação para a loja. Em produção é obrigatória: é por ela que a loja
  // fica sabendo do pagamento aprovado.
  const lojaUrl = opcional(env, 'LOJA_URL');
  const lojaSegredo = opcional(env, 'LOJA_WEBHOOK_SECRET');
  if (Boolean(lojaUrl) !== Boolean(lojaSegredo)) {
    throw new Error('LOJA_URL e LOJA_WEBHOOK_SECRET andam juntas: defina as duas ou nenhuma.');
  }
  if (producao && (!lojaUrl || !lojaSegredo)) {
    throw new Error('LOJA_URL e LOJA_WEBHOOK_SECRET são obrigatórias em produção.');
  }
  if (producao && lojaUrl && !lojaUrl.startsWith('https://')) {
    throw new Error('LOJA_URL deve começar com https:// em produção.');
  }
  if (producao && lojaSegredo && lojaSegredo.length < TAMANHO_MINIMO_CHAVE) {
    throw new Error(
      `LOJA_WEBHOOK_SECRET fraco: use ao menos ${TAMANHO_MINIMO_CHAVE} caracteres em produção.`,
    );
  }

  const urlNotificacao = opcional(env, 'MERCADOPAGO_URL_NOTIFICACAO');
  if (urlNotificacao && !urlNotificacao.startsWith('https://')) {
    // A API do Mercado Pago recusa notification_url sem HTTPS.
    throw new Error('MERCADOPAGO_URL_NOTIFICACAO deve começar com https://.');
  }
  if (opcional(env, 'MERCADOPAGO_ACCESS_TOKEN') && !opcional(env, 'MERCADOPAGO_WEBHOOK_SECRET')) {
    // Token sem segredo deixaria o webhook sem verificação: falha cedo.
    throw new Error('MERCADOPAGO_WEBHOOK_SECRET é obrigatório quando há MERCADOPAGO_ACCESS_TOKEN.');
  }

  return {
    ambiente,
    producao,
    // PORTA explícita vence; senão a PORT que Railway/Render/Fly injetam.
    porta: opcional(env, 'PORTA') ? inteiro(env, 'PORTA', 3011) : inteiro(env, 'PORT', 3011),
    databaseUrl: obrigatoria(env, 'DATABASE_URL'),
    chavesApi,
    // Atrás do proxy da plataforma (Railway/Render/Fly) o IP real vem no
    // X-Forwarded-For; sem isso o rate limit veria só o IP do proxy.
    confiarNoProxy: env.CONFIAR_NO_PROXY === 'true',
    nivelLog: opcional(env, 'NIVEL_LOG') ?? 'info',
    // Limite por IP nas rotas públicas (webhooks), por minuto.
    limiteWebhooksPorMinuto: inteiro(env, 'LIMITE_WEBHOOKS_POR_MINUTO', 120),
    // Segredo do provider fake (HMAC dos webhooks). O fake e o PIX simulado só
    // existem fora de produção: lá eles seriam uma porta para forjar pagamentos.
    fakeWebhookSecret: producao ? undefined : obrigatoria(env, 'FAKE_WEBHOOK_SECRET'),
    lojaUrl,
    lojaWebhookSecret: lojaSegredo,
    // Mercado Pago: liga quando token e segredo do webhook existem. Em Preview e
    // desenvolvimento, use as credenciais de TESTE; em produção, as de produção.
    mercadoPagoAccessToken: opcional(env, 'MERCADOPAGO_ACCESS_TOKEN'),
    mercadoPagoWebhookSecret: opcional(env, 'MERCADOPAGO_WEBHOOK_SECRET'),
    // URL pública (HTTPS) do nosso /webhooks/mercadopago, enviada em cada cobrança.
    mercadoPagoUrlNotificacao: opcional(env, 'MERCADOPAGO_URL_NOTIFICACAO'),
    mercadoPagoParcelasMaximas: inteiro(env, 'MERCADOPAGO_PARCELAS_MAXIMAS', 12),
    // Stripe é opcional: sem as chaves, o adaptador fica desligado.
    stripeSecretKey: opcional(env, 'STRIPE_SECRET_KEY'),
    stripeWebhookSecret: opcional(env, 'STRIPE_WEBHOOK_SECRET'),
  } as const;
}

export type Config = ReturnType<typeof carregarConfig>;

export const config: Config = carregarConfig();
