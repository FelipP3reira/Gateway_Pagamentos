import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';

import { config } from '../config.ts';
import type { BancoDeDados } from '../db/esquema.ts';
import { AssinaturaInvalida, ErroDeAplicacao } from '../erros.ts';
import { podeTransicionar } from '../dominio/maquina-estados.ts';
import type { RepositorioDePagamentos } from '../dominio/repositorio.ts';
import type { Pagamento } from '../dominio/tipos.ts';
import { verificarHmac } from '../seguranca/hmac.ts';
import { gerarBrCode } from './brcode.ts';
import { criarChave, type ChavePix, type TipoChave } from './chave.ts';
import { gerarQr, type QrGerado } from './qr.ts';

const RECEBEDOR_PADRAO = 'Gateway Sandbox';
const CIDADE_PADRAO = 'SAO PAULO';

export interface NovaCobrancaPix {
  chave: string;
  valorCentavos: number;
  nomeRecebedor?: string;
  cidade?: string;
  chaveIdempotencia: string;
}

export interface CobrancaPix {
  pagamento: Pagamento;
  txid: string;
  copiaECola: string;
  qr: QrGerado;
}

export class ServicoPix {
  constructor(
    private readonly db: Kysely<BancoDeDados>,
    private readonly repo: RepositorioDePagamentos,
  ) {}

  /** Gera/registra uma chave PIX (sandbox — não vai ao DICT). */
  async gerarChave(tipo: TipoChave, titular: string, valor?: string): Promise<ChavePix> {
    if (!titular || titular.trim() === '') {
      throw new ErroDeAplicacao(400, 'titular_obrigatorio', 'Informe o titular da chave.');
    }
    const { chave } = criarChave(tipo, valor);

    const inserida = await this.db
      .insertInto('chaves_pix')
      .values({ tipo, chave, titular })
      .onConflict((oc) => oc.column('chave').doNothing())
      .returning(['tipo', 'chave'])
      .executeTakeFirst();

    // Chave já registrada (CPF/e-mail/telefone repetido): devolve a existente.
    if (!inserida) {
      const existente = await this.db
        .selectFrom('chaves_pix')
        .select(['tipo', 'chave'])
        .where('chave', '=', chave)
        .executeTakeFirstOrThrow();
      return existente;
    }
    return inserida;
  }

  /**
   * Cria a cobrança: um pagamento `pendente` (método PIX), o BR Code copia e
   * cola e o QR. Idempotente pela chave — repetir devolve a mesma cobrança.
   */
  async criarCobranca(nova: NovaCobrancaPix): Promise<CobrancaPix> {
    const { pagamento, nova: primeira } = await this.repo.criarIdempotente({
      provedor: 'pix',
      valorCentavos: nova.valorCentavos,
      moeda: 'BRL',
      tokenMetodo: nova.chave,
      capturaAutomatica: false,
      chaveIdempotencia: nova.chaveIdempotencia,
    });

    if (!primeira) {
      const existente = await this.db
        .selectFrom('cobrancas_pix')
        .selectAll()
        .where('pagamento_id', '=', pagamento.id)
        .executeTakeFirstOrThrow();
      return {
        pagamento,
        txid: existente.txid,
        copiaECola: existente.copia_e_cola,
        qr: await gerarQr(existente.copia_e_cola),
      };
    }

    // txid do PIX: alfanumérico, até 25 caracteres.
    const txid = randomUUID().replace(/-/g, '').slice(0, 25);
    const copiaECola = gerarBrCode({
      chave: nova.chave,
      valorCentavos: nova.valorCentavos,
      nomeRecebedor: nova.nomeRecebedor ?? RECEBEDOR_PADRAO,
      cidade: nova.cidade ?? CIDADE_PADRAO,
      txid,
    });

    await this.repo.guardarReferenciaExterna(pagamento.id, txid);
    await this.db
      .insertInto('cobrancas_pix')
      .values({ pagamento_id: pagamento.id, txid, chave: nova.chave, copia_e_cola: copiaECola })
      .execute();

    return { pagamento, txid, copiaECola, qr: await gerarQr(copiaECola) };
  }

  /**
   * Confirma o pagamento a partir do webhook do PSP (sandbox, assinado por HMAC).
   * Idempotente: reivindica o evento por (pix, evento_id) antes de liquidar, e a
   * máquina de estados impede liquidar duas vezes. Uma transferência PIX é
   * liquidada de uma vez, então caminha pendente → autorizado → capturado.
   */
  async confirmar(
    corpoCru: Buffer,
    assinatura: string | undefined,
  ): Promise<{ processado: boolean }> {
    if (!assinatura || !verificarHmac(corpoCru, assinatura, config.fakeWebhookSecret)) {
      throw new AssinaturaInvalida();
    }
    const evento = JSON.parse(corpoCru.toString('utf8')) as {
      id: string;
      txid: string;
      status: string;
    };

    const reivindicado = await this.db
      .insertInto('webhook_eventos')
      .values({
        provedor: 'pix',
        evento_id: evento.id,
        tipo: `pix.${evento.status}`,
        pagamento_id: null,
      })
      .onConflict((oc) => oc.columns(['provedor', 'evento_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!reivindicado) {
      return { processado: false };
    }

    if (evento.status === 'CONCLUIDA') {
      const pagamento = await this.repo.buscarPorReferencia('pix', evento.txid);
      if (pagamento) {
        await this.db
          .updateTable('webhook_eventos')
          .set({ pagamento_id: pagamento.id })
          .where('id', '=', reivindicado.id)
          .execute();

        if (podeTransicionar(pagamento.estado, 'autorizado')) {
          await this.repo.transicionar(pagamento.id, 'autorizado', 'pix confirmado');
          await this.repo.transicionar(pagamento.id, 'capturado', 'pix liquidado');
        }
      }
    }

    return { processado: true };
  }
}
