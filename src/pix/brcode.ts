// Gera o "PIX Copia e Cola" (BR Code) conforme o padrão EMV® adotado pelo Banco
// Central. É formatação TLV (id + tamanho + valor) fechada por um CRC16-CCITT.
// O payload é real e válido — um app de banco leria. Quem recebe é que precisa
// ser uma chave PIX registrada de verdade (aqui, em sandbox, é simulada).

export interface DadosBrCode {
  chave: string;
  valorCentavos: number;
  nomeRecebedor: string;
  cidade: string;
  txid: string;
}

// id + tamanho (2 dígitos) + valor. O tamanho é o comprimento do valor.
function campo(id: string, valor: string): string {
  const tamanho = valor.length.toString().padStart(2, '0');
  return `${id}${tamanho}${valor}`;
}

// CRC16-CCITT (poly 0x1021, init 0xFFFF, sem reflexão) — o mesmo do BR Code.
// Vetor de referência: crc16('123456789') === '29B1'.
export function crc16(texto: string): string {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Texto sem acento e em caixa alta, como os campos do BR Code esperam. O NFD
// separa a letra da marca de acento, e o filtro seguinte descarta a marca.
function normalizar(texto: string, tamanhoMax: number): string {
  return texto
    .normalize('NFD')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .toUpperCase()
    .slice(0, tamanhoMax)
    .trim();
}

export function gerarBrCode(dados: DadosBrCode): string {
  const valor = (dados.valorCentavos / 100).toFixed(2);

  // Conta do recebedor (26): GUI do PIX + a chave.
  const contaPix = campo('00', 'br.gov.bcb.pix') + campo('01', dados.chave);
  // Campo adicional (62): o txid, para conciliar o pagamento.
  const adicional = campo('05', dados.txid);

  const semCrc =
    campo('00', '01') + // Payload Format Indicator
    campo('01', '12') + // uso único (cobrança com valor)
    campo('26', contaPix) +
    campo('52', '0000') + // Merchant Category Code
    campo('53', '986') + // moeda: BRL (ISO 4217)
    campo('54', valor) +
    campo('58', 'BR') + // país
    campo('59', normalizar(dados.nomeRecebedor, 25)) +
    campo('60', normalizar(dados.cidade, 15)) +
    campo('62', adicional) +
    '6304'; // id + tamanho do CRC, que entram no cálculo

  return semCrc + crc16(semCrc);
}
