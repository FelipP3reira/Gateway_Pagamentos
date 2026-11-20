import type { Kysely } from 'kysely';

import type { BancoDeDados, Estado, Provedor } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';
import type { ContextoWebhook } from '../provedores/provedor.ts';
import type { RepositorioDePagamentos } from '../dominio/repositorio.ts';
import type { RegistroDeProvedores } from '../provedores/registro.ts';

export interface ResultadoWebhook {
  // false quando o evento já tinha sido processado (duplicado) — no-op.
  processado: boolean;
}

export class ProcessadorDeWebhook {
  private readonly db: Kysely<BancoDeDados>;
  private readonly repo: RepositorioDePagamentos;
  private readonly registro: RegistroDeProvedores;

  constructor(
    db: Kysely<BancoDeDados>,
    repo: RepositorioDePagamentos,
    registro: RegistroDeProvedores,
  ) {
    this.db = db;
    this.repo = repo;
    this.registro = registro;
  }

  /**
   * Verifica a assinatura, garante o processamento único e aplica o efeito.
   *
   * A ordem importa: primeiro CLAIMA o evento inserindo em webhook_eventos com
   * (provedor, evento_id) único. Se a linha não entrou, o evento já foi tratado
   * — retorna no-op. É isso que impede o webhook duplicado de capturar duas
   * vezes, mesmo com dois webhooks chegando ao mesmo tempo. A máquina de estados
   * é a segunda trava: um evento fora de ordem não força transição inválida.
   *
   * Quando o evento só avisa "mudou" (`exigeConsulta`, caso do Mercado Pago), o
   * estado é consultado no provedor ANTES do claim: se a consulta falhar, o
   * webhook responde erro e o provedor reenvia — o evento não fica marcado como
   * tratado sem ter tido efeito.
   */
  async processar(
    nomeProvedor: Provedor,
    corpoCru: Buffer,
    assinatura: string | undefined,
    contexto?: ContextoWebhook,
  ): Promise<ResultadoWebhook> {
    const provedor = this.registro.obter(nomeProvedor);
    // Lança AssinaturaInvalida (401) se a assinatura não bater — nada roda.
    const evento = provedor.verificarWebhook(corpoCru, assinatura, contexto);

    const pagamento = evento.referenciaExterna
      ? await this.repo.buscarPorReferencia(nomeProvedor, evento.referenciaExterna)
      : null;

    let estado: Estado | null = evento.estado;
    // Só consulta pagamentos nossos: evento de cobrança alheia não gera chamada.
    if (evento.exigeConsulta && pagamento && evento.referenciaExterna) {
      try {
        estado = await provedor.consultar(evento.referenciaExterna);
      } catch {
        throw new ErroDeAplicacao(
          502,
          'provedor_falhou',
          'Não foi possível consultar o provedor; reenvie o evento.',
        );
      }
    }

    const reivindicado = await this.db
      .insertInto('webhook_eventos')
      .values({
        provedor: nomeProvedor,
        evento_id: evento.id,
        tipo: evento.tipo,
        pagamento_id: pagamento?.id ?? null,
      })
      .onConflict((oc) => oc.columns(['provedor', 'evento_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!reivindicado) {
      // Duplicado: já processamos este evento. No-op, sem cobrar de novo.
      return { processado: false };
    }

    if (estado && pagamento) {
      // Avança pelo caminho válido (Pix pago: pendente → autorizado → capturado).
      // Um evento que reafirma o estado atual, ou que a máquina não aceita, vira
      // no-op em vez de erro.
      await this.repo.avancar(pagamento.id, estado, `webhook ${evento.tipo}`);
    }

    return { processado: true };
  }
}
