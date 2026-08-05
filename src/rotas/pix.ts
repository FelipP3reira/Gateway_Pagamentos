import type { FastifyInstance } from 'fastify';

import { ErroDeAplicacao } from '../erros.ts';
import type { ServicoPix } from '../pix/servico-pix.ts';

interface CorpoChave {
  tipo: 'aleatoria' | 'cpf' | 'email' | 'telefone';
  titular: string;
  valor?: string;
}

interface CorpoCobranca {
  chave: string;
  valorCentavos: number;
  nomeRecebedor?: string;
  cidade?: string;
}

const schemaChave = {
  type: 'object',
  required: ['tipo', 'titular'],
  additionalProperties: false,
  properties: {
    tipo: { type: 'string', enum: ['aleatoria', 'cpf', 'email', 'telefone'] },
    titular: { type: 'string', minLength: 1 },
    valor: { type: 'string' },
  },
};

const schemaCobranca = {
  type: 'object',
  required: ['chave', 'valorCentavos'],
  additionalProperties: false,
  properties: {
    chave: { type: 'string', minLength: 1 },
    valorCentavos: { type: 'integer', minimum: 1 },
    nomeRecebedor: { type: 'string' },
    cidade: { type: 'string' },
  },
};

function cabecalho(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

export function registrarRotasPix(app: FastifyInstance, deps: { pix: ServicoPix }): void {
  const { pix } = deps;

  app.post<{ Body: CorpoChave }>(
    '/pix/chaves',
    { schema: { body: schemaChave } },
    async (requisicao, resposta) => {
      const { tipo, titular, valor } = requisicao.body;
      const chave = await pix.gerarChave(tipo, titular, valor);
      // Deixa explícito que a chave é de sandbox.
      return resposta.status(201).send({ ...chave, sandbox: true });
    },
  );

  app.post<{ Body: CorpoCobranca }>(
    '/pix/cobrancas',
    { schema: { body: schemaCobranca } },
    async (requisicao, resposta) => {
      const chave = requisicao.headers['idempotency-key'];
      if (typeof chave !== 'string' || chave.length === 0) {
        throw new ErroDeAplicacao(
          400,
          'sem_chave_idempotencia',
          'Header Idempotency-Key é obrigatório.',
        );
      }
      const corpo = requisicao.body;
      const cobranca = await pix.criarCobranca({
        chave: corpo.chave,
        valorCentavos: corpo.valorCentavos,
        nomeRecebedor: corpo.nomeRecebedor,
        cidade: corpo.cidade,
        chaveIdempotencia: chave,
      });

      return resposta.status(201).send({
        pagamentoId: cobranca.pagamento.id,
        estado: cobranca.pagamento.estado,
        valorCentavos: cobranca.pagamento.valorCentavos,
        txid: cobranca.txid,
        copiaECola: cobranca.copiaECola,
        qrCodeSvg: cobranca.qr.svg,
        qrCodePng: cobranca.qr.pngDataUri,
      });
    },
  );

  // Webhook de confirmação do PSP (sandbox). Rota estática, tem prioridade sobre
  // /webhooks/:provedor.
  app.post('/webhooks/pix', async (requisicao, resposta) => {
    const corpoCru = requisicao.corpoCru;
    if (!corpoCru || corpoCru.length === 0) {
      throw new ErroDeAplicacao(400, 'corpo_vazio', 'Webhook sem corpo.');
    }
    const assinatura = cabecalho(requisicao.headers['x-assinatura']);
    const resultado = await pix.confirmar(corpoCru, assinatura);
    return resposta.status(200).send({ recebido: true, processado: resultado.processado });
  });
}
