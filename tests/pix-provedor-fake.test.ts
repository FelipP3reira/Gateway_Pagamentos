import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { caminhoAte } from '../src/dominio/maquina-estados.ts';
import { ProvedorFake } from '../src/provedores/fake.ts';
import { RegistroDeProvedores } from '../src/provedores/registro.ts';
import { assinarHmac } from '../src/seguranca/hmac.ts';
import { limparBanco } from './auxiliar.ts';

const SEGREDO = 'segredo-fake';
const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;
let fake: ProvedorFake;

beforeEach(async () => {
  await limparBanco(db);
  fake = new ProvedorFake(SEGREDO);
  app = montarApp({ db, registro: new RegistroDeProvedores().registrar(fake) });
});
afterAll(() => db.destroy());

function criarPix(chave: string) {
  return app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': chave },
    payload: { provedor: 'fake', metodo: 'pix', valorCentavos: 4_990, moeda: 'BRL' },
  });
}

describe('Pix no provider fake (para os testes da loja)', () => {
  it('nasce pendente com QR e copia e cola válidos', async () => {
    const resposta = await criarPix('fake-pix');
    expect(resposta.statusCode).toBe(201);
    const pagamento = resposta.json();
    expect(pagamento).toMatchObject({ estado: 'pendente', metodo: 'pix' });
    expect(pagamento.pix.copiaECola).toMatch(/^000201.*6304[0-9A-F]{4}$/);
    expect(pagamento.pix.qrCodeBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('liquida com o webhook assinado do fake (pendente → capturado)', async () => {
    const pagamento = (await criarPix('fake-pix-pago')).json();
    const corpo = JSON.stringify({
      id: 'evt_pix_1',
      tipo: 'pix.pago',
      referenciaExterna: pagamento.referenciaExterna,
      estado: 'capturado',
    });
    const recebido = await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: {
        'content-type': 'application/json',
        'x-assinatura': assinarHmac(Buffer.from(corpo), SEGREDO),
      },
      payload: corpo,
    });
    expect(recebido.json()).toEqual({ recebido: true, processado: true });

    const atual = await app.inject({ method: 'GET', url: `/pagamentos/${pagamento.id}` });
    expect(atual.json()).toMatchObject({ estado: 'capturado' });
  });

  it('a reconciliação também alcança o pago a partir de pendente', async () => {
    const pagamento = (await criarPix('fake-pix-rec')).json();
    await fake.capturar(pagamento.referenciaExterna as string);

    const resposta = await app.inject({
      method: 'POST',
      url: `/pagamentos/${pagamento.id}/reconciliar`,
    });
    expect(resposta.json()).toMatchObject({ estado: 'capturado', ajustado: true });
  });
});

describe('caminhoAte', () => {
  it('acha o menor caminho válido', () => {
    expect(caminhoAte('pendente', 'capturado')).toEqual(['autorizado', 'capturado']);
    expect(caminhoAte('pendente', 'estornado')).toEqual(['autorizado', 'capturado', 'estornado']);
    expect(caminhoAte('autorizado', 'capturado')).toEqual(['capturado']);
    expect(caminhoAte('pendente', 'falhou')).toEqual(['falhou']);
  });

  it('[] quando já está no alvo; null quando não há caminho', () => {
    expect(caminhoAte('capturado', 'capturado')).toEqual([]);
    expect(caminhoAte('capturado', 'pendente')).toBeNull();
    expect(caminhoAte('estornado', 'capturado')).toBeNull();
    expect(caminhoAte('falhou', 'capturado')).toBeNull();
    expect(caminhoAte('capturado', 'cancelado')).toBeNull();
  });
});
