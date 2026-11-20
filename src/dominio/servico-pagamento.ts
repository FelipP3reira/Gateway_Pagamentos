import type { Kysely } from 'kysely';

import type { BancoDeDados } from '../db/esquema.ts';
import { ErroDeAplicacao, RecusaDoProvedor } from '../erros.ts';
import type { DadosCobranca } from '../provedores/provedor.ts';
import type { RegistroDeProvedores } from '../provedores/registro.ts';
import { garantirTransicao } from './maquina-estados.ts';
import type { RepositorioDePagamentos } from './repositorio.ts';
import type { NovaCobranca, Pagamento } from './tipos.ts';

export class ServicoDePagamento {
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
   * Cria a cobrança. Idempotente pela chave: se o pagamento já existe, devolve
   * o que está lá SEM chamar o provedor de novo — é o que garante que uma
   * requisição repetida nunca cobra duas vezes. Só o primeiro pedido fala com o
   * provedor e caminha pela máquina de estados.
   */
  async criar(nova: NovaCobranca): Promise<Pagamento> {
    // Provedor indisponível é barrado antes de gravar: senão sobraria um
    // pagamento `pendente` órfão que nunca falou com provedor nenhum.
    const provedor = this.registro.obter(nova.provedor);
    const metodo = nova.metodo ?? 'cartao';
    if (!provedor.metodos.includes(metodo)) {
      throw new ErroDeAplicacao(
        400,
        'metodo_indisponivel',
        `O provedor "${provedor.nome}" não cobra por ${metodo}.`,
      );
    }
    const parcelas = nova.parcelas ?? 1;
    if (metodo === 'pix' && parcelas !== 1) {
      throw new ErroDeAplicacao(400, 'parcelas_invalidas', 'Pix é sempre à vista (1 parcela).');
    }
    if (parcelas > provedor.parcelasMaximas) {
      throw new ErroDeAplicacao(
        400,
        'parcelas_invalidas',
        `O provedor "${provedor.nome}" aceita no máximo ${provedor.parcelasMaximas} parcela(s).`,
      );
    }

    const dados: DadosCobranca = {
      metodo,
      valorCentavos: nova.valorCentavos,
      moeda: nova.moeda,
      tokenMetodo: nova.tokenMetodo,
      descricao: nova.descricao,
      capturaAutomatica: nova.capturaAutomatica,
      chaveIdempotencia: nova.chaveIdempotencia,
      parcelas,
      metodoPagamentoId: nova.metodoPagamentoId,
      emissorId: nova.emissorId,
      pagador: nova.pagador,
      pixExpiraEmMinutos: nova.pixExpiraEmMinutos,
    };
    // Regras do próprio provedor, também antes de gravar.
    provedor.validarCobranca?.(dados);

    const { pagamento, nova: primeira } = await this.repo.criarIdempotente({ ...nova, metodo });
    if (!primeira) {
      return pagamento;
    }

    let resultado;
    try {
      resultado = await provedor.autorizar(dados);
    } catch (erro) {
      // Recusa definitiva (4xx de validação): a cobrança não existe no provedor,
      // então o desfecho é conhecido — falhou.
      if (erro instanceof RecusaDoProvedor) {
        return this.repo.transicionar(
          pagamento.id,
          'falhou',
          `recusado pelo provedor (${erro.codigo})`,
        );
      }
      // O provedor falhou de forma inesperada (rede, etc.). Deixa o pagamento em
      // `pendente`: a reconciliação decide o desfecho, sem marcar falso negativo.
      throw new ErroDeAplicacao(502, 'provedor_falhou', 'O provedor não respondeu à autorização.');
    }

    await this.repo.guardarReferenciaExterna(pagamento.id, resultado.referenciaExterna);
    if (resultado.pix) {
      await this.repo.guardarDadosPix(pagamento.id, resultado.pix);
    }

    if (resultado.estado === 'falhou') {
      return this.repo.transicionar(pagamento.id, 'falhou', 'autorização recusada');
    }

    // Pix aguardando transferência ou cartão em análise: segue pendente até o
    // webhook (ou a reconciliação) trazer o desfecho.
    if (resultado.estado === 'pendente') {
      return (await this.repo.buscar(pagamento.id))!;
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
