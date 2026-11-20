import type { Pagamento } from './tipos.ts';

// Resposta pública do pagamento. Não há dado sensível para omitir — o token do
// método nunca é guardado —, mas a saída é explícita de propósito.
export function apresentar(p: Pagamento) {
  return {
    id: p.id,
    provedor: p.provedor,
    estado: p.estado,
    valorCentavos: p.valorCentavos,
    moeda: p.moeda,
    referenciaExterna: p.referenciaExterna,
    referenciaPedido: p.referenciaPedido,
    descricao: p.descricao,
    parcelas: p.parcelas,
    metodoPagamentoId: p.metodoPagamentoId,
    emissorId: p.emissorId,
    metodo: p.metodo,
    // Copia e cola, QR (PNG base64) e validade da cobrança Pix do provedor.
    pix: p.pix,
    criadoEm: p.criadoEm,
    atualizadoEm: p.atualizadoEm,
  };
}
