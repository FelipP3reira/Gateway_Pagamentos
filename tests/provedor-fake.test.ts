import { describe, expect, it } from 'vitest';

import { ProvedorFake, TOKEN_QUE_FALHA } from '../src/provedores/fake.ts';
import type { DadosCobranca } from '../src/provedores/provedor.ts';

function dados(sobrescrever: Partial<DadosCobranca> = {}): DadosCobranca {
  return {
    valorCentavos: 1990,
    moeda: 'BRL',
    tokenMetodo: 'tok_fake_ok',
    capturaAutomatica: false,
    chaveIdempotencia: 'k1',
    ...sobrescrever,
  };
}

describe('provider fake', () => {
  it('autoriza sem capturar quando a captura não é automática', async () => {
    const fake = new ProvedorFake('segredo');

    const r = await fake.autorizar(dados());

    expect(r.estado).toBe('autorizado');
    expect(r.referenciaExterna).toMatch(/^fake_pi_/);
    expect(await fake.consultar(r.referenciaExterna)).toBe('autorizado');
  });

  it('captura na hora quando a captura é automática', async () => {
    const fake = new ProvedorFake('segredo');

    const r = await fake.autorizar(dados({ capturaAutomatica: true }));

    expect(r.estado).toBe('capturado');
  });

  it('o token de falha faz a autorização falhar', async () => {
    const fake = new ProvedorFake('segredo');

    const r = await fake.autorizar(dados({ tokenMetodo: TOKEN_QUE_FALHA }));

    expect(r.estado).toBe('falhou');
  });

  it('captura, estorna e cancela refletem no consultar', async () => {
    const fake = new ProvedorFake('segredo');
    const autorizado = await fake.autorizar(dados());

    await fake.capturar(autorizado.referenciaExterna);
    expect(await fake.consultar(autorizado.referenciaExterna)).toBe('capturado');

    const estorno = await fake.estornar(autorizado.referenciaExterna, 1990);
    expect(estorno.referenciaExterna).toMatch(/^fake_re_/);
    expect(await fake.consultar(autorizado.referenciaExterna)).toBe('estornado');

    const outro = await fake.autorizar(dados({ chaveIdempotencia: 'k2' }));
    await fake.cancelar(outro.referenciaExterna);
    expect(await fake.consultar(outro.referenciaExterna)).toBe('cancelado');
  });
});
