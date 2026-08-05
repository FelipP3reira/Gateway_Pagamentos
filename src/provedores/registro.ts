import Stripe from 'stripe';

import { config } from '../config.ts';
import type { Provedor } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';
import { ProvedorFake } from './fake.ts';
import type { ProvedorDePagamento } from './provedor.ts';
import { AdaptadorStripe } from './stripe.ts';

// Mapa nome→provedor. O serviço pede pelo nome e nunca conhece o adaptador.
export class RegistroDeProvedores {
  private readonly provedores = new Map<Provedor, ProvedorDePagamento>();

  registrar(provedor: ProvedorDePagamento): this {
    this.provedores.set(provedor.nome, provedor);
    return this;
  }

  obter(nome: Provedor): ProvedorDePagamento {
    const provedor = this.provedores.get(nome);
    if (!provedor) {
      throw new ErroDeAplicacao(
        400,
        'provedor_indisponivel',
        `Provedor "${nome}" não está disponível.`,
      );
    }
    return provedor;
  }

  tem(nome: Provedor): boolean {
    return this.provedores.has(nome);
  }
}

/**
 * Monta o registro a partir da config: o provider fake sempre entra; a Stripe
 * só quando as duas chaves existem — sem elas o adaptador fica de fora e o site
 * funciona no modo fake.
 */
export function montarRegistro(): RegistroDeProvedores {
  const registro = new RegistroDeProvedores().registrar(new ProvedorFake());

  if (config.stripeSecretKey && config.stripeWebhookSecret) {
    const stripe = new Stripe(config.stripeSecretKey);
    registro.registrar(new AdaptadorStripe(stripe, config.stripeWebhookSecret));
  }

  return registro;
}
