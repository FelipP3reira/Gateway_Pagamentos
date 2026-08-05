import type { Kysely } from 'kysely';

import type { BancoDeDados, Provedor } from '../db/esquema.ts';
import { podeTransicionar } from '../dominio/maquina-estados.ts';
import type { RepositorioDePagamentos } from '../dominio/repositorio.ts';
import type { RegistroDeProvedores } from '../provedores/registro.ts';

export interface ResultadoWebhook {
  // false quando o evento já tinha sido processado (duplicado) — no-op.
  processado: boolean;
}

export class ProcessadorDeWebhook {
  constructor(
    private readonly db: Kysely<BancoDeDados>,
    private readonly repo: RepositorioDePagamentos,
    private readonly registro: RegistroDeProvedores,
  ) {}

  /**
   * Verifica a assinatura, garante o processamento único e aplica o efeito.
   *
   * A ordem importa: primeiro CLAIMA o evento inserindo em webhook_eventos com
   * (provedor, evento_id) único. Se a linha não entrou, o evento já foi tratado
   * — retorna no-op. É isso que impede o webhook duplicado de capturar duas
   * vezes, mesmo com dois webhooks chegando ao mesmo tempo. A máquina de estados
   * é a segunda trava: um evento fora de ordem não força transição inválida.
   */
  async processar(
    nomeProvedor: Provedor,
    corpoCru: Buffer,
    assinatura: string | undefined,
  ): Promise<ResultadoWebhook> {
    const provedor = this.registro.obter(nomeProvedor);
    // Lança AssinaturaInvalida (401) se a assinatura não bater — nada roda.
    const evento = provedor.verificarWebhook(corpoCru, assinatura);

    const reivindicado = await this.db
      .insertInto('webhook_eventos')
      .values({
        provedor: nomeProvedor,
        evento_id: evento.id,
        tipo: evento.tipo,
        pagamento_id: null,
      })
      .onConflict((oc) => oc.columns(['provedor', 'evento_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!reivindicado) {
      // Duplicado: já processamos este evento. No-op, sem cobrar de novo.
      return { processado: false };
    }

    if (evento.estado && evento.referenciaExterna) {
      const pagamento = await this.repo.buscarPorReferencia(nomeProvedor, evento.referenciaExterna);
      if (pagamento) {
        await this.db
          .updateTable('webhook_eventos')
          .set({ pagamento_id: pagamento.id })
          .where('id', '=', reivindicado.id)
          .execute();

        // Só transiciona se for válido; um evento repetido de outro id que
        // reafirma o mesmo estado vira no-op em vez de erro.
        if (podeTransicionar(pagamento.estado, evento.estado)) {
          await this.repo.transicionar(pagamento.id, evento.estado, `webhook ${evento.tipo}`);
        }
      }
    }

    return { processado: true };
  }
}
