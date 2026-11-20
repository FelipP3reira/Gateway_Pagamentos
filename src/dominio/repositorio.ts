import { randomUUID } from 'node:crypto';

import type { Kysely, Selectable, Transaction } from 'kysely';

import type { BancoDeDados, Estado, Provedor, TabelaPagamentos } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';
import { montarPayloadNotificacao } from '../notificacoes/payload.ts';
import { caminhoAte, garantirTransicao } from './maquina-estados.ts';
import type { DadosPix, NovaCobranca, Pagamento } from './tipos.ts';

function mapear(linha: Selectable<TabelaPagamentos>): Pagamento {
  return {
    id: linha.id,
    provedor: linha.provedor,
    referenciaExterna: linha.referencia_externa,
    estado: linha.estado,
    valorCentavos: linha.valor_centavos,
    moeda: linha.moeda,
    descricao: linha.descricao,
    parcelas: linha.parcelas,
    metodoPagamentoId: linha.metodo_pagamento_id,
    emissorId: linha.emissor_id,
    metodo: linha.metodo,
    pix: linha.pix_copia_e_cola
      ? {
          copiaECola: linha.pix_copia_e_cola,
          qrCodeBase64: linha.pix_qr_code_base64,
          urlTicket: linha.pix_url_ticket,
          expiraEm: linha.pix_expira_em,
        }
      : null,
    referenciaPedido: linha.referencia_pedido,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
  };
}

export interface OpcoesRepositorio {
  // Grava no outbox uma notificação para a loja a cada mudança de estado.
  // Desligado sem LOJA_URL (desenvolvimento) para não acumular fila.
  notificarLoja?: boolean;
}

export class RepositorioDePagamentos {
  private readonly db: Kysely<BancoDeDados>;
  private readonly notificarLoja: boolean;

  constructor(db: Kysely<BancoDeDados>, opcoes: OpcoesRepositorio = {}) {
    this.db = db;
    this.notificarLoja = opcoes.notificarLoja ?? false;
  }

  /**
   * Enfileira a notificação na MESMA transação da mudança de estado: se a
   * transição grava, a notificação grava; se uma falha, nenhuma fica. É o que
   * garante que a loja nunca perde uma mudança (padrão outbox).
   */
  private async enfileirarNotificacao(
    tx: Transaction<BancoDeDados>,
    linha: Selectable<TabelaPagamentos>,
    sequencia: number,
  ): Promise<void> {
    if (!this.notificarLoja) {
      return;
    }
    const eventoId = randomUUID();
    const agora = new Date();
    const pagamento = mapear({ ...linha, atualizado_em: agora });
    await tx
      .insertInto('notificacoes_loja')
      .values({
        pagamento_id: linha.id,
        evento_id: eventoId,
        sequencia,
        estado: linha.estado,
        payload: JSON.stringify(montarPayloadNotificacao(pagamento, eventoId, sequencia, agora)),
      })
      .execute();
  }

  /**
   * Cria o pagamento em `pendente` de forma idempotente: a mesma
   * chave_idempotencia nunca gera dois. Grava a transição inicial junto, na
   * mesma transação. Retorna se foi criado agora (`nova`) — o serviço usa isso
   * para só chamar o provedor uma vez.
   */
  async criarIdempotente(nova: NovaCobranca): Promise<{ pagamento: Pagamento; nova: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      const inserida = await tx
        .insertInto('pagamentos')
        .values({
          provedor: nova.provedor,
          estado: 'pendente',
          valor_centavos: nova.valorCentavos,
          moeda: nova.moeda,
          chave_idempotencia: nova.chaveIdempotencia,
          descricao: nova.descricao ?? null,
          parcelas: nova.parcelas ?? 1,
          metodo_pagamento_id: nova.metodoPagamentoId ?? null,
          emissor_id: nova.emissorId ?? null,
          metodo: nova.metodo ?? 'cartao',
          referencia_pedido: nova.referenciaPedido ?? null,
        })
        .onConflict((oc) => oc.column('chave_idempotencia').doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserida) {
        await tx
          .insertInto('transicoes')
          .values({
            pagamento_id: inserida.id,
            de_estado: null,
            para_estado: 'pendente',
            motivo: 'criado',
          })
          .execute();
        return { pagamento: mapear(inserida), nova: true };
      }

      const existente = await tx
        .selectFrom('pagamentos')
        .selectAll()
        .where('chave_idempotencia', '=', nova.chaveIdempotencia)
        .executeTakeFirstOrThrow();
      return { pagamento: mapear(existente), nova: false };
    });
  }

  async buscar(id: number): Promise<Pagamento | null> {
    const linha = await this.db
      .selectFrom('pagamentos')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return linha ? mapear(linha) : null;
  }

  async guardarReferenciaExterna(id: number, referencia: string): Promise<void> {
    await this.db
      .updateTable('pagamentos')
      .set({ referencia_externa: referencia, atualizado_em: new Date() })
      .where('id', '=', id)
      .execute();
  }

  // Guarda a cobrança Pix que o provedor devolveu (QR, copia e cola, validade).
  async guardarDadosPix(id: number, pix: DadosPix): Promise<void> {
    await this.db
      .updateTable('pagamentos')
      .set({
        pix_copia_e_cola: pix.copiaECola,
        pix_qr_code_base64: pix.qrCodeBase64,
        pix_url_ticket: pix.urlTicket,
        pix_expira_em: pix.expiraEm,
        atualizado_em: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  // Tentativas de pagamento de um pedido da loja, da mais recente para a mais
  // antiga (um pedido pode ter várias: cartão recusado e depois Pix).
  async listarPorReferenciaPedido(referenciaPedido: string): Promise<Pagamento[]> {
    const linhas = await this.db
      .selectFrom('pagamentos')
      .selectAll()
      .where('referencia_pedido', '=', referenciaPedido)
      .orderBy('criado_em', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return linhas.map(mapear);
  }

  // Acha o pagamento pela referência do provedor — o webhook chega com ela, não
  // com o nosso id.
  async buscarPorReferencia(provedor: Provedor, referencia: string): Promise<Pagamento | null> {
    const linha = await this.db
      .selectFrom('pagamentos')
      .selectAll()
      .where('provedor', '=', provedor)
      .where('referencia_externa', '=', referencia)
      .executeTakeFirst();
    return linha ? mapear(linha) : null;
  }

  /**
   * Muda o estado de forma atômica e auditada. Trava a linha (FOR UPDATE) para
   * duas transições concorrentes serializarem: a segunda vê o estado já mudado
   * e é barrada pela máquina de estados — é a defesa contra dupla captura no
   * nível do estado, além da idempotência do webhook.
   */
  async transicionar(id: number, para: Estado, motivo?: string): Promise<Pagamento> {
    return this.db.transaction().execute(async (tx) => {
      const atual = await tx
        .selectFrom('pagamentos')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!atual) {
        throw new ErroDeAplicacao(404, 'nao_encontrado', 'Pagamento não encontrado.');
      }

      garantirTransicao(atual.estado, para);

      await tx
        .updateTable('pagamentos')
        .set({ estado: para, atualizado_em: new Date() })
        .where('id', '=', id)
        .execute();

      const transicao = await tx
        .insertInto('transicoes')
        .values({
          pagamento_id: id,
          de_estado: atual.estado,
          para_estado: para,
          motivo: motivo ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await this.enfileirarNotificacao(tx, { ...atual, estado: para }, transicao.id);
      return { ...mapear(atual), estado: para };
    });
  }

  /**
   * Avança o pagamento até `alvo` pelo menor caminho válido, numa transação só
   * e com a linha travada: o caminho é calculado a partir do estado travado,
   * então dois eventos concorrentes serializam em vez de colidir. Cada passo vira
   * uma linha de auditoria. Sem caminho (ou já no alvo), nada muda.
   */
  async avancar(
    id: number,
    alvo: Estado,
    motivo: string,
  ): Promise<{ pagamento: Pagamento; mudou: boolean }> {
    return this.db.transaction().execute(async (tx) => {
      const atual = await tx
        .selectFrom('pagamentos')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!atual) {
        throw new ErroDeAplicacao(404, 'nao_encontrado', 'Pagamento não encontrado.');
      }

      const caminho = caminhoAte(atual.estado, alvo);
      if (!caminho || caminho.length === 0) {
        return { pagamento: mapear(atual), mudou: false };
      }

      let de = atual.estado;
      let ultimaTransicao = 0;
      for (const para of caminho) {
        const transicao = await tx
          .insertInto('transicoes')
          .values({ pagamento_id: id, de_estado: de, para_estado: para, motivo })
          .returning('id')
          .executeTakeFirstOrThrow();
        ultimaTransicao = transicao.id;
        de = para;
      }
      await tx
        .updateTable('pagamentos')
        .set({ estado: alvo, atualizado_em: new Date() })
        .where('id', '=', id)
        .execute();

      // Uma notificação só, com o estado final (não uma por passo).
      await this.enfileirarNotificacao(tx, { ...atual, estado: alvo }, ultimaTransicao);

      return { pagamento: { ...mapear(atual), estado: alvo }, mudou: true };
    });
  }
}
