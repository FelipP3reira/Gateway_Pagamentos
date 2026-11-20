import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ErroDeAplicacao } from '../erros.ts';

// Rotas que não exigem a chave da API: os webhooks se protegem pela assinatura
// do provedor, e o health check precisa responder à plataforma sem segredo.
function ehRotaPublica(url: string): boolean {
  const caminho = url.split('?', 1)[0] ?? '';
  return caminho === '/saude' || caminho.startsWith('/webhooks/');
}

// Resumo de tamanho fixo: comparar os hashes em tempo constante não vaza nem o
// conteúdo nem o tamanho da chave esperada.
function resumo(valor: string): Buffer {
  return createHash('sha256').update(valor, 'utf8').digest();
}

/**
 * Confere a chave contra todas as aceitas (a atual e, durante uma rotação, a
 * anterior). Percorre a lista inteira sem sair cedo, para o tempo não indicar
 * qual delas bateu.
 */
export function chaveValida(recebida: string, aceitas: readonly string[]): boolean {
  const alvo = resumo(recebida);
  let valida = false;
  for (const chave of aceitas) {
    if (timingSafeEqual(alvo, resumo(chave))) {
      valida = true;
    }
  }
  return valida;
}

function extrairBearer(requisicao: FastifyRequest): string | undefined {
  const cabecalho = requisicao.headers.authorization;
  if (typeof cabecalho !== 'string') {
    return undefined;
  }
  const [esquema, token] = cabecalho.split(' ');
  return esquema?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Exige `Authorization: Bearer <GATEWAY_API_KEY>` em todas as rotas, exceto as
 * públicas. Sem chaves configuradas (só permitido fora de produção — o config
 * barra no boot), a API fica aberta para o desenvolvimento local.
 */
export function exigirChaveDaApi(app: FastifyInstance, aceitas: readonly string[]): void {
  if (aceitas.length === 0) {
    app.log.warn('GATEWAY_API_KEY ausente: API aberta (permitido só fora de produção).');
    return;
  }

  app.addHook('onRequest', (requisicao, _resposta, done) => {
    if (ehRotaPublica(requisicao.url)) {
      done();
      return;
    }
    const token = extrairBearer(requisicao);
    if (!token || !chaveValida(token, aceitas)) {
      // Mesma resposta para ausente e errada: não ajuda quem está tentando.
      done(new ErroDeAplicacao(401, 'nao_autorizado', 'Chave da API ausente ou inválida.'));
      return;
    }
    done();
  });
}
