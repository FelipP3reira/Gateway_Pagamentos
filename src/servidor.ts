import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { config } from './config.ts';
import { ErroDeAplicacao } from './erros.ts';

// Guarda o corpo cru da requisição na própria request. A verificação de
// assinatura de webhook precisa dos bytes exatos, não do JSON reparseado.
declare module 'fastify' {
  interface FastifyRequest {
    corpoCru?: Buffer;
  }
}

export function criarServidor(): FastifyInstance {
  const app = Fastify({
    logger: config.ambiente !== 'teste' && {
      // Nunca logar segredos nem dados de assinatura/autorização.
      redact: [
        'req.headers.authorization',
        'req.headers["stripe-signature"]',
        'req.headers["x-assinatura"]',
      ],
    },
  });

  // Mantém o corpo cru (Buffer) e ainda entrega o JSON parseado às rotas comuns.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (requisicao, corpo, done) => {
    const buffer = corpo as Buffer;
    requisicao.corpoCru = buffer;
    if (buffer.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      done(new ErroDeAplicacao(400, 'json_invalido', 'Corpo JSON inválido.'), undefined);
    }
  });

  app.get('/saude', () => ({ status: 'ok', ambiente: config.ambiente }));

  app.setNotFoundHandler((_req, resposta) => {
    void resposta.status(404).send({
      erro: { codigo: 'nao_encontrado', mensagem: 'Rota não encontrada.' },
    });
  });

  app.setErrorHandler((erro: FastifyError, _req, resposta) => {
    // Erro previsto carrega o próprio status e código.
    if (erro instanceof ErroDeAplicacao) {
      void resposta.status(erro.statusCode).send({
        erro: { codigo: erro.codigo, mensagem: erro.message },
      });
      return;
    }
    // Validação do próprio Fastify (schema) vira 400 com código estável.
    if (erro.statusCode && erro.statusCode < 500) {
      void resposta.status(erro.statusCode).send({
        erro: { codigo: 'requisicao_invalida', mensagem: erro.message },
      });
      return;
    }
    // O resto é 500 sem vazar detalhe interno.
    app.log.error(erro);
    void resposta.status(500).send({
      erro: { codigo: 'erro_interno', mensagem: 'Erro interno.' },
    });
  });

  return app;
}
