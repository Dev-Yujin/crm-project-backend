import Stripe from 'stripe';

const REQUIRED_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_STARTER',
  'STRIPE_PRICE_BUSINESS',
  'STRIPE_PRICE_SCALE',
];

for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    throw new Error(`Missing ${name} environment variable`);
  }
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
