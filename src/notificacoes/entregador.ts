import type { Kysely, Selectable } from 'kysely';

import type { BancoDeDados, TabelaNotificacoesLoja } from '../db/esquema.ts';
import { assinarNotificacao } from './payload.ts';

export type ClienteHttp = (url: string, init: RequestInit) => Promise<Response>;

export interface OpcoesEntregador {
  // Base da loja, ex.: https://loja.exemplo.com. O caminho é fixo.
  urlLoja: string;
  segredo: string;
  http?: ClienteHttp;
  agora?: () => Date;
  aleatorio?: () => number;
  // Quantas notificações por rodada.
  lote?: number;
  // Depois de tantas tentativas, a notificação vai para `falhou` (reenvio manual).
  maxTentativas?: number;
  // Backoff exponencial: base * 2^(n-1), limitado ao teto, com jitter de ±20%.
  backoffBaseMs?: number;
  backoffTetoMs?: number;
  timeoutMs?: number;
  // Intervalo entre rodadas do laço.
  intervaloMs?: number;
  aoErro?: (erro: unknown) => void;
}

export const CAMINHO_WEBHOOK_LOJA = '/api/webhooks/gateway';

export interface ResultadoLote {
  entregues: number;
  falhas: number;
}

/**
 * Entrega as notificações do outbox para a loja.
 *
 * Cada rodada "aluga" um lote: marca a próxima tentativa para depois do tempo
 * máximo de uma entrega, com FOR UPDATE SKIP LOCKED. Assim duas instâncias (ou
 * duas rodadas sobrepostas) nunca entregam a mesma notificação ao mesmo tempo,
 * e se o processo cair no meio a notificação volta sozinha quando o aluguel
 * vence. A entrega é "pelo menos uma vez": a loja deduplica por eventoId.
 */
export class EntregadorDeNotificacoes {
  private readonly db: Kysely<BancoDeDados>;
  private readonly url: string;
  private readonly segredo: string;
  private readonly http: ClienteHttp;
  private readonly agora: () => Date;
  private readonly aleatorio: () => number;
  private readonly lote: number;
  private readonly maxTentativas: number;
  private readonly backoffBaseMs: number;
  private readonly backoffTetoMs: number;
  private readonly timeoutMs: number;
  private readonly intervaloMs: number;
  private readonly aoErro: (erro: unknown) => void;

  private temporizador: NodeJS.Timeout | undefined;
  private rodadaAtual: Promise<unknown> | undefined;
  private parado = true;

  constructor(db: Kysely<BancoDeDados>, opcoes: OpcoesEntregador) {
    this.db = db;
    this.url = `${opcoes.urlLoja.replace(/\/+$/, '')}${CAMINHO_WEBHOOK_LOJA}`;
    this.segredo = opcoes.segredo;
    this.http = opcoes.http ?? fetch;
    this.agora = opcoes.agora ?? (() => new Date());
    this.aleatorio = opcoes.aleatorio ?? Math.random;
    this.lote = opcoes.lote ?? 20;
    this.maxTentativas = opcoes.maxTentativas ?? 10;
    this.backoffBaseMs = opcoes.backoffBaseMs ?? 30_000;
    this.backoffTetoMs = opcoes.backoffTetoMs ?? 60 * 60_000;
    this.timeoutMs = opcoes.timeoutMs ?? 10_000;
    this.intervaloMs = opcoes.intervaloMs ?? 5_000;
    this.aoErro = opcoes.aoErro ?? (() => {});
  }

  // Espera antes da tentativa n+1, depois de n falhas.
  atrasoMs(falhas: number): number {
    const exponencial = Math.min(this.backoffBaseMs * 2 ** (falhas - 1), this.backoffTetoMs);
    const jitter = 0.8 + 0.4 * this.aleatorio();
    return Math.round(exponencial * jitter);
  }

  async processarLote(): Promise<ResultadoLote> {
    const agora = this.agora();
    // O aluguel cobre a entrega mais lenta possível, com folga.
    const aluguelAte = new Date(agora.getTime() + this.timeoutMs * 3);

    const alugadas = await this.db.transaction().execute(async (tx) => {
      const linhas = await tx
        .selectFrom('notificacoes_loja')
        .selectAll()
        .where('status', '=', 'pendente')
        .where('proxima_tentativa_em', '<=', agora)
        .orderBy('proxima_tentativa_em')
        .orderBy('id')
        .limit(this.lote)
        .forUpdate()
        .skipLocked()
        .execute();
      if (linhas.length > 0) {
        await tx
          .updateTable('notificacoes_loja')
          .set({ proxima_tentativa_em: aluguelAte })
          .where(
            'id',
            'in',
            linhas.map((l) => l.id),
          )
          .execute();
      }
      return linhas;
    });

    const resultado: ResultadoLote = { entregues: 0, falhas: 0 };
    // Em série: mantém a ordem das notificações de um mesmo pagamento no caso
    // comum (sem falhas). Fora de ordem, a loja usa a `sequencia`.
    for (const notificacao of alugadas) {
      if (await this.entregar(notificacao)) {
        resultado.entregues++;
      } else {
        resultado.falhas++;
      }
    }
    return resultado;
  }

  private async entregar(notificacao: Selectable<TabelaNotificacoesLoja>): Promise<boolean> {
    const corpo = JSON.stringify(notificacao.payload);
    const inicio = Date.now();
    const ts = Math.floor(this.agora().getTime() / 1000);
    let statusHttp: number | null = null;
    let erro: string | null = null;

    try {
      const resposta = await this.http(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Evento': notificacao.evento_id,
          'X-Gateway-Assinatura': assinarNotificacao(corpo, this.segredo, ts),
        },
        body: corpo,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      statusHttp = resposta.status;
      // Consome o corpo para liberar a conexão; o conteúdo não importa.
      await resposta.text().catch(() => '');
      if (!resposta.ok) {
        erro = `HTTP ${resposta.status}`;
      }
    } catch (falha) {
      erro = falha instanceof Error ? `${falha.name}: ${falha.message}` : 'erro desconhecido';
    }

    const tentativas = notificacao.tentativas + 1;
    const duracaoMs = Date.now() - inicio;
    const agora = this.agora();

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('tentativas_notificacao')
        .values({
          notificacao_id: notificacao.id,
          numero: tentativas,
          status_http: statusHttp,
          erro,
          duracao_ms: duracaoMs,
        })
        .execute();

      if (erro === null) {
        await tx
          .updateTable('notificacoes_loja')
          .set({ status: 'entregue', tentativas, entregue_em: agora, ultimo_erro: null })
          .where('id', '=', notificacao.id)
          .execute();
        return;
      }

      const esgotou = tentativas >= this.maxTentativas;
      await tx
        .updateTable('notificacoes_loja')
        .set({
          status: esgotou ? 'falhou' : 'pendente',
          tentativas,
          ultimo_erro: erro,
          proxima_tentativa_em: new Date(agora.getTime() + this.atrasoMs(tentativas)),
        })
        .where('id', '=', notificacao.id)
        .execute();
    });

    return erro === null;
  }

  // Laço: uma rodada, espera o intervalo, outra rodada. Nunca sobrepõe rodadas.
  iniciar(): void {
    if (!this.parado) {
      return;
    }
    this.parado = false;
    const rodar = (): void => {
      if (this.parado) {
        return;
      }
      this.rodadaAtual = this.processarLote()
        .catch((erro: unknown) => {
          this.aoErro(erro);
        })
        .finally(() => {
          if (!this.parado) {
            this.temporizador = setTimeout(rodar, this.intervaloMs);
          }
        });
    };
    rodar();
  }

  // Para o laço e espera a rodada em andamento terminar (desligamento limpo).
  async parar(): Promise<void> {
    this.parado = true;
    if (this.temporizador) {
      clearTimeout(this.temporizador);
    }
    await this.rodadaAtual;
  }
}
