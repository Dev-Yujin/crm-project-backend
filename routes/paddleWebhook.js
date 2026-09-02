import { EventName } from '@paddle/paddle-node-sdk';
import { paddle } from '../config/paddle.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

const SUBSCRIPTION_EVENTS = new Set([
  EventName.SubscriptionCreated,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
]);

// Express handler. The route this is mounted on MUST use express.raw({ type:
// 'application/json' }) — Paddle's signature check needs the exact raw request bytes,
// not a re-serialized JSON.parse of them.
export async function paddleWebhookHandler(req, res) {
  const signature = req.headers['paddle-signature'] ?? '';
  const rawRequestBody = req.body.toString();
  let eventData;

  try {
    eventData = await paddle.webhooks.unmarshal(
      rawRequestBody,
      process.env.PADDLE_WEBHOOK_SECRET,
      signature,
    );
  } catch (err) {
    console.error('Paddle webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (SUBSCRIPTION_EVENTS.has(eventData.eventType)) {
    try {
      await upsertBillingFromSubscription(eventData.data);
    } catch (err) {
      console.error('Failed to apply Paddle webhook event:', err);
      res.status(500).send('Webhook handler failed');
      return;
    }
  }

  res.json({ received: true });
}
