// Erro previsto da aplicação: carrega o status HTTP e um código estável para o
// cliente. O handler central transforma no envelope { erro: { codigo, mensagem } }.
export class ErroDeAplicacao extends Error {
  constructor(
    readonly statusCode: number,
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ErroDeAplicacao';
  }
}

// Transição de estado inválida — atalho semântico usado pela máquina de estados.
export class TransicaoInvalida extends ErroDeAplicacao {
  constructor(mensagem: string) {
    super(409, 'transicao_invalida', mensagem);
    this.name = 'TransicaoInvalida';
  }
}

// Assinatura de webhook ausente ou inválida. Sempre 401, sem vazar o motivo
// exato para não ajudar quem tenta forjar.
export class AssinaturaInvalida extends ErroDeAplicacao {
  constructor() {
    super(401, 'assinatura_invalida', 'Assinatura do webhook ausente ou inválida.');
    this.name = 'AssinaturaInvalida';
  }
}
