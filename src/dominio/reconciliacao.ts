import { ErroDeAplicacao } from '../erros.ts';
import type { RegistroDeProvedores } from '../provedores/registro.ts';
import { podeTransicionar } from './maquina-estados.ts';
import type { RepositorioDePagamentos } from './repositorio.ts';
import type { Pagamento } from './tipos.ts';

export interface ResultadoReconciliacao {
  pagamento: Pagamento;
  // true quando o estado local estava atrás do provedor e foi corrigido.
  ajustado: boolean;
}

/**
 * Reconciliação: o provedor é a fonte da verdade. Consulta o estado lá e, se o
 * nosso estiver atrás (ex.: um webhook se perdeu), avança o local até alcançá-lo
 * — sempre por uma transição válida, nunca forçando um salto proibido.
 */
export class ServicoDeReconciliacao {
  constructor(
    private readonly repo: RepositorioDePagamentos,
    private readonly registro: RegistroDeProvedores,
  ) {}

  async reconciliar(id: number): Promise<ResultadoReconciliacao> {
    const pagamento = await this.repo.buscar(id);
    if (!pagamento) {
      throw new ErroDeAplicacao(404, 'nao_encontrado', 'Pagamento não encontrado.');
    }
    // Sem referência no provedor não há o que reconciliar (nunca saiu de pendente).
    if (!pagamento.referenciaExterna) {
      return { pagamento, ajustado: false };
    }

    const provedor = this.registro.obter(pagamento.provedor);
    const estadoNoProvedor = await provedor.consultar(pagamento.referenciaExterna);

    if (estadoNoProvedor === pagamento.estado) {
      return { pagamento, ajustado: false };
    }

    // Só corrige quando o provedor está à frente por um caminho válido. Uma
    // divergência que a máquina de estados não aceita é inconsistência real e
    // não é "consertada" às escondidas — fica visível para investigação.
    if (!podeTransicionar(pagamento.estado, estadoNoProvedor)) {
      return { pagamento, ajustado: false };
    }

    const atualizado = await this.repo.transicionar(
      id,
      estadoNoProvedor,
      `reconciliação com o provedor (${estadoNoProvedor})`,
    );
    return { pagamento: atualizado, ajustado: true };
  }
}
