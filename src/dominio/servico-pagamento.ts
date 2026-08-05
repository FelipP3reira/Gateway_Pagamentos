import type { Kysely } from 'kysely';

import type { BancoDeDados } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';
import type { RegistroDeProvedores } from '../provedores/registro.ts';
import { garantirTransicao } from './maquina-estados.ts';
import type { RepositorioDePagamentos } from './repositorio.ts';
import type { NovaCobranca, Pagamento } from './tipos.ts';

export class ServicoDePagamento {
  constructor(
    private readonly db: Kysely<BancoDeDados>,
    private readonly repo: RepositorioDePagamentos,
    private readonly registro: RegistroDeProvedores,
  ) {}

  /**
   * Cria a cobrança. Idempotente pela chave: se o pagamento já existe, devolve
   * o que está lá SEM chamar o provedor de novo — é o que garante que uma
   * requisição repetida nunca cobra duas vezes. Só o primeiro pedido fala com o
   * provedor e caminha pela máquina de estados.
   */
  async criar(nova: NovaCobranca): Promise<Pagamento> {
    const { pagamento, nova: primeira } = await this.repo.criarIdempotente(nova);
    if (!primeira) {
      return pagamento;
    }

    const provedor = this.registro.obter(nova.provedor);

    let resultado;
    try {
      resultado = await provedor.autorizar({
        valorCentavos: nova.valorCentavos,
        moeda: nova.moeda,
        tokenMetodo: nova.tokenMetodo,
        descricao: nova.descricao,
        capturaAutomatica: nova.capturaAutomatica,
        chaveIdempotencia: nova.chaveIdempotencia,
      });
    } catch {
      // O provedor falhou de forma inesperada (rede, etc.). Deixa o pagamento em
      // `pendente`: a reconciliação decide o desfecho, sem marcar falso negativo.
      throw new ErroDeAplicacao(502, 'provedor_falhou', 'O provedor não respondeu à autorização.');
    }

    await this.repo.guardarReferenciaExterna(pagamento.id, resultado.referenciaExterna);

    if (resultado.estado === 'falhou') {
      return this.repo.transicionar(pagamento.id, 'falhou', 'autorização recusada');
    }

    // Sempre passa por autorizado; a captura automática dá o segundo passo.
    await this.repo.transicionar(pagamento.id, 'autorizado', 'autorizado pelo provedor');
    if (resultado.estado === 'capturado') {
      return this.repo.transicionar(pagamento.id, 'capturado', 'capturado na autorização');
    }
    return (await this.repo.buscar(pagamento.id))!;
  }

  async capturar(id: number): Promise<Pagamento> {
    const pagamento = await this.exigir(id);
    // Barra a operação inválida ANTES de tocar no provedor.
    garantirTransicao(pagamento.estado, 'capturado');
    await this.registro.obter(pagamento.provedor).capturar(this.exigirReferencia(pagamento));
    return this.repo.transicionar(id, 'capturado', 'captura solicitada');
  }

  async estornar(id: number): Promise<Pagamento> {
    const pagamento = await this.exigir(id);
    garantirTransicao(pagamento.estado, 'estornado');
    const provedor = this.registro.obter(pagamento.provedor);
    const estorno = await provedor.estornar(
      this.exigirReferencia(pagamento),
      pagamento.valorCentavos,
    );
    await this.db
      .insertInto('estornos')
      .values({
        pagamento_id: pagamento.id,
        valor_centavos: pagamento.valorCentavos,
        referencia_externa: estorno.referenciaExterna,
      })
      .execute();
    return this.repo.transicionar(id, 'estornado', 'estorno solicitado');
  }

  async cancelar(id: number): Promise<Pagamento> {
    const pagamento = await this.exigir(id);
    garantirTransicao(pagamento.estado, 'cancelado');
    await this.registro.obter(pagamento.provedor).cancelar(this.exigirReferencia(pagamento));
    return this.repo.transicionar(id, 'cancelado', 'cancelamento solicitado');
  }

  async buscar(id: number): Promise<Pagamento> {
    return this.exigir(id);
  }

  private async exigir(id: number): Promise<Pagamento> {
    const pagamento = await this.repo.buscar(id);
    if (!pagamento) {
      throw new ErroDeAplicacao(404, 'nao_encontrado', 'Pagamento não encontrado.');
    }
    return pagamento;
  }

  private exigirReferencia(pagamento: Pagamento): string {
    if (!pagamento.referenciaExterna) {
      throw new ErroDeAplicacao(409, 'sem_referencia', 'Pagamento sem referência no provedor.');
    }
    return pagamento.referenciaExterna;
  }
}
