import type { Kysely, Selectable } from 'kysely';

import type { BancoDeDados, Estado, Provedor, TabelaPagamentos } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';
import { garantirTransicao } from './maquina-estados.ts';
import type { NovaCobranca, Pagamento } from './tipos.ts';

function mapear(linha: Selectable<TabelaPagamentos>): Pagamento {
  return {
    id: linha.id,
    provedor: linha.provedor,
    referenciaExterna: linha.referencia_externa,
    estado: linha.estado,
    valorCentavos: linha.valor_centavos,
    moeda: linha.moeda,
    descricao: linha.descricao,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
  };
}

export class RepositorioDePagamentos {
  constructor(private readonly db: Kysely<BancoDeDados>) {}

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

      await tx
        .insertInto('transicoes')
        .values({
          pagamento_id: id,
          de_estado: atual.estado,
          para_estado: para,
          motivo: motivo ?? null,
        })
        .execute();

      return { ...mapear(atual), estado: para };
    });
  }
}
