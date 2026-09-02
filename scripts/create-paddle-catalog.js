// One-time setup: creates the 3 Paddle products (Starter/Business/Scale) and their 6
// prices (month/year each) in whichever Paddle account config/paddle.js is pointed at.
// NOT idempotent — it does not check for existing products by name — so run it once,
// copy the printed price ids into config/plans.js's paddlePriceId fields (and into
// crm-frontend's src/lib/paddleTiers.ts), and don't run it again.
//
// Usage: node scripts/create-paddle-catalog.js

import { paddle } from '../config/paddle.js';
import { PLANS } from '../config/plans.js';

async function createTierCatalog(key, plan) {
  const product = await paddle.products.create({
    name: `Continuum CRM — ${plan.name}`,
    taxCategory: 'saas',
  });

  const monthly = await paddle.prices.create({
    description: `${plan.name} monthly`,
    productId: product.id,
    unitPrice: { amount: String(plan.priceMonthlyUsd * 100), currencyCode: 'USD' },
    billingCycle: { interval: 'month', frequency: 1 },
    taxMode: 'account_setting',
  });

  const yearlyUsd = plan.priceMonthlyUsd * 10; // 2 months free, per spec
  const yearly = await paddle.prices.create({
    description: `${plan.name} yearly`,
    productId: product.id,
    unitPrice: { amount: String(yearlyUsd * 100), currencyCode: 'USD' },
    billingCycle: { interval: 'year', frequency: 1 },
    taxMode: 'account_setting',
  });

  return { key, productId: product.id, month: monthly.id, year: yearly.id };
}

async function main() {
  const results = [];
  for (const [key, plan] of Object.entries(PLANS)) {
    results.push(await createTierCatalog(key, plan));
  }

  console.log('\nCreated Paddle catalog — paste these into config/plans.js\'s paddlePriceId');
  console.log('fields, and into crm-frontend/src/lib/paddleTiers.ts (Task 9):\n');
  for (const r of results) {
    console.log(`${r.key}: month=${r.month} year=${r.year}  (product ${r.productId})`);
  }
}

main().catch((err) => {
  console.error('Catalog creation failed:', err);
  process.exit(1);
});
