import { randomUUID } from 'node:crypto';

import { config } from '../config.ts';
import { AssinaturaInvalida, ErroDeAplicacao } from '../erros.ts';
import { verificarHmac } from '../seguranca/hmac.ts';
import type {
  DadosCobranca,
  EstadoProvedor,
  EventoWebhook,
  ProvedorDePagamento,
  ResultadoProvedor,
} from './provedor.ts';

// Token que faz a autorização falhar de propósito — para exercitar o caminho
// de falha nos testes sem depender de rede.
export const TOKEN_QUE_FALHA = 'tok_fake_falha';

interface CobrancaFake {
  estado: EstadoProvedor;
  valorCentavos: number;
}

/**
 * Provider fake, determinístico e em memória. Cobre o fluxo inteiro sem rede
 * nem chave, e assina/verifica webhooks com HMAC — o mesmo contrato de
 * segurança do provedor real, só que sob nosso controle.
 */
export class ProvedorFake implements ProvedorDePagamento {
  readonly nome = 'fake' as const;
  private readonly cobrancas = new Map<string, CobrancaFake>();

  constructor(private readonly segredo: string = config.fakeWebhookSecret) {}

  autorizar(dados: DadosCobranca): Promise<ResultadoProvedor> {
    const referenciaExterna = `fake_pi_${randomUUID()}`;
    const estado: EstadoProvedor =
      dados.tokenMetodo === TOKEN_QUE_FALHA
        ? 'falhou'
        : dados.capturaAutomatica
          ? 'capturado'
          : 'autorizado';
    this.cobrancas.set(referenciaExterna, { estado, valorCentavos: dados.valorCentavos });
    return Promise.resolve({ referenciaExterna, estado });
  }

  capturar(referenciaExterna: string): Promise<ResultadoProvedor> {
    const cobranca = this.exigir(referenciaExterna);
    cobranca.estado = 'capturado';
    return Promise.resolve({ referenciaExterna, estado: 'capturado' });
  }

  estornar(
    referenciaExterna: string,
    _valorCentavos: number,
  ): Promise<{ referenciaExterna: string }> {
    const cobranca = this.exigir(referenciaExterna);
    cobranca.estado = 'estornado';
    return Promise.resolve({ referenciaExterna: `fake_re_${randomUUID()}` });
  }

  cancelar(referenciaExterna: string): Promise<void> {
    const cobranca = this.exigir(referenciaExterna);
    cobranca.estado = 'cancelado';
    return Promise.resolve();
  }

  consultar(referenciaExterna: string): Promise<EstadoProvedor> {
    return Promise.resolve(this.exigir(referenciaExterna).estado);
  }

  verificarWebhook(corpoCru: Buffer, assinatura: string | undefined): EventoWebhook {
    if (!assinatura || !verificarHmac(corpoCru, assinatura, this.segredo)) {
      throw new AssinaturaInvalida();
    }
    // Só chega aqui com assinatura válida — o corpo é confiável.
    const evento = JSON.parse(corpoCru.toString('utf8')) as {
      id: string;
      tipo: string;
      referenciaExterna?: string | null;
      estado?: EstadoProvedor | null;
    };
    return {
      id: evento.id,
      tipo: evento.tipo,
      referenciaExterna: evento.referenciaExterna ?? null,
      estado: evento.estado ?? null,
    };
  }

  private exigir(referenciaExterna: string): CobrancaFake {
    const cobranca = this.cobrancas.get(referenciaExterna);
    if (!cobranca) {
      throw new ErroDeAplicacao(
        404,
        'referencia_desconhecida',
        'Cobrança não encontrada no provedor.',
      );
    }
    return cobranca;
  }
}
