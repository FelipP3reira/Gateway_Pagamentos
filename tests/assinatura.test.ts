import { describe, expect, it } from 'vitest';

import { AssinaturaInvalida } from '../src/erros.ts';
import { ProvedorFake } from '../src/provedores/fake.ts';
import { assinarHmac } from '../src/seguranca/hmac.ts';

const SEGREDO = 'segredo-do-teste';
const fake = new ProvedorFake(SEGREDO);

function corpoDe(evento: object): Buffer {
  return Buffer.from(JSON.stringify(evento), 'utf8');
}

const evento = {
  id: 'evt_1',
  tipo: 'payment_intent.succeeded',
  referenciaExterna: 'fake_pi_1',
  estado: 'capturado',
};

describe('verificação de assinatura do webhook', () => {
  it('aceita e normaliza um webhook com assinatura válida', () => {
    const corpo = corpoDe(evento);
    const assinatura = assinarHmac(corpo, SEGREDO);

    const resultado = fake.verificarWebhook(corpo, assinatura);

    expect(resultado).toMatchObject({
      id: 'evt_1',
      tipo: 'payment_intent.succeeded',
      referenciaExterna: 'fake_pi_1',
      estado: 'capturado',
    });
  });

  it('rejeita quando não há assinatura', () => {
    const corpo = corpoDe(evento);

    expect(() => fake.verificarWebhook(corpo, undefined)).toThrow(AssinaturaInvalida);
  });

  it('rejeita assinatura de outro segredo', () => {
    const corpo = corpoDe(evento);
    const assinaturaErrada = assinarHmac(corpo, 'segredo-do-atacante');

    expect(() => fake.verificarWebhook(corpo, assinaturaErrada)).toThrow(AssinaturaInvalida);
  });

  it('rejeita corpo adulterado depois de assinado', () => {
    const corpo = corpoDe(evento);
    const assinatura = assinarHmac(corpo, SEGREDO);
    const corpoAdulterado = corpoDe({ ...evento, estado: 'estornado' });

    expect(() => fake.verificarWebhook(corpoAdulterado, assinatura)).toThrow(AssinaturaInvalida);
  });
});
