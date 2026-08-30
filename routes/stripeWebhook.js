import { stripe } from '../config/stripe.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

// Express handler. The route this is mounted on MUST use express.raw({ type:
// 'application/json' }) — Stripe's signature check needs the exact raw request bytes,
// not a re-serialized JSON.parse of them.
export async function stripeWebhookHandler(req, res) {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    try {
      await upsertBillingFromSubscription(event.data.object);
    } catch (err) {
      console.error('Failed to apply Stripe webhook event:', err);
      res.status(500).send('Webhook handler failed');
      return;
    }
  }

  res.json({ received: true });
}
