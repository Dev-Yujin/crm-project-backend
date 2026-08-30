import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripeWebhookHandler } from './stripeWebhook.js';
import { stripe } from '../config/stripe.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

vi.mock('../models/billing.js', () => ({
  upsertBillingFromSubscription: vi.fn(),
}));

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('stripeWebhookHandler', () => {
  beforeEach(() => {
    upsertBillingFromSubscription.mockReset();
  });

  it('rejects a request with an invalid signature', async () => {
    const req = { headers: { 'stripe-signature': 'bad' }, body: Buffer.from('{}') };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('applies a valid customer.subscription.updated event', async () => {
    const subscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_starter' } }] },
      current_period_end: 1893456000,
    };
    const payload = JSON.stringify({
      id: 'evt_123',
      type: 'customer.subscription.updated',
      data: { object: subscription },
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const req = { headers: { 'stripe-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).toHaveBeenCalledWith(subscription);
  });

  it('ignores an event type it does not handle', async () => {
    const payload = JSON.stringify({ id: 'evt_456', type: 'invoice.paid', data: { object: {} } });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const req = { headers: { 'stripe-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('responds 500 when upsertBillingFromSubscription throws (e.g. no matching group_billing row)', async () => {
    upsertBillingFromSubscription.mockRejectedValueOnce(new Error('No group_billing row found for Stripe customer cus_123'));

    const subscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_starter' } }] },
      current_period_end: 1893456000,
    };
    const payload = JSON.stringify({
      id: 'evt_789',
      type: 'customer.subscription.updated',
      data: { object: subscription },
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET,
    });

    const req = { headers: { 'stripe-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await stripeWebhookHandler(req, res);

    expect(res.statusCode).toBe(500);
  });
});
