import QRCode from 'qrcode';

export interface QrGerado {
  svg: string;
  // PNG embutido como data URI, pronto para um <img src="...">.
  pngDataUri: string;
}

// Renderiza o BR Code como QR. Correção de erro média (M) é a usada pelos apps
// de banco em PIX.
export async function gerarQr(brcode: string): Promise<QrGerado> {
  const [svg, pngDataUri] = await Promise.all([
    QRCode.toString(brcode, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }),
    QRCode.toDataURL(brcode, { errorCorrectionLevel: 'M', margin: 1 }),
  ]);
  return { svg, pngDataUri };
}
