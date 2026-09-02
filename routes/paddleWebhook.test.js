import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { paddleWebhookHandler } from './paddleWebhook.js';
import { upsertBillingFromSubscription } from '../models/billing.js';

vi.mock('../models/billing.js', () => ({
  upsertBillingFromSubscription: vi.fn(),
}));

function signPaddlePayload(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac('sha256', secret).update(`${ts}:${payload}`).digest('hex');
  return `ts=${ts};h1=${hmac}`;
}

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

describe('paddleWebhookHandler', () => {
  beforeEach(() => {
    upsertBillingFromSubscription.mockReset();
  });

  it('rejects a request with an invalid signature', async () => {
    const req = { headers: { 'paddle-signature': 'ts=1;h1=bad' }, body: Buffer.from('{}') };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('applies a valid subscription.updated event', async () => {
    // Paddle's actual webhook wire format is snake_case (this is what gets sent as the
    // raw request body); paddle.webhooks.unmarshal() parses it into a camelCase
    // SubscriptionNotification, which is what upsertBillingFromSubscription receives.
    const rawSubscription = {
      id: 'sub_123',
      customer_id: 'ctm_123',
      status: 'active',
      billing_cycle: { interval: 'month', frequency: 1 },
      current_billing_period: { starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-12-01T00:00:00.000Z' },
      items: [{ price: { id: 'pri_starter_month' } }],
      custom_data: null,
    };
    const payload = JSON.stringify({
      event_id: 'evt_123',
      event_type: 'subscription.updated',
      data: rawSubscription,
    });
    const header = signPaddlePayload(payload, process.env.PADDLE_WEBHOOK_SECRET);

    const req = { headers: { 'paddle-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).toHaveBeenCalledWith({
      id: 'sub_123',
      status: 'active',
      customerId: 'ctm_123',
      businessId: null,
      startedAt: null,
      firstBilledAt: null,
      nextBilledAt: null,
      pausedAt: null,
      canceledAt: null,
      discount: null,
      billingDetails: null,
      currentBillingPeriod: { startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' },
      billingCycle: { interval: 'month', frequency: 1 },
      scheduledChange: null,
      items: [
        {
          previouslyBilledAt: null,
          nextBilledAt: null,
          trialDates: null,
          price: {
            id: 'pri_starter_month',
            name: null,
            type: null,
            billingCycle: null,
            trialPeriod: null,
            unitPrice: null,
            unitPriceOverrides: [],
            quantity: null,
            status: null,
            customData: null,
            importMeta: null,
          },
          product: null,
        },
      ],
      customData: null,
      importMeta: null,
    });
  });

  it('ignores an event type it does not handle', async () => {
    const payload = JSON.stringify({
      event_id: 'evt_456',
      event_type: 'transaction.completed',
      data: { items: [], payments: [] },
    });
    const header = signPaddlePayload(payload, process.env.PADDLE_WEBHOOK_SECRET);

    const req = { headers: { 'paddle-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(upsertBillingFromSubscription).not.toHaveBeenCalled();
  });

  it('responds 500 when upsertBillingFromSubscription throws', async () => {
    upsertBillingFromSubscription.mockRejectedValueOnce(new Error('boom'));

    const rawSubscription = {
      id: 'sub_789',
      customer_id: 'ctm_789',
      status: 'active',
      billing_cycle: { interval: 'month', frequency: 1 },
      items: [{ price: { id: 'pri_starter_month' } }],
      custom_data: null,
    };
    const payload = JSON.stringify({
      event_id: 'evt_789',
      event_type: 'subscription.created',
      data: rawSubscription,
    });
    const header = signPaddlePayload(payload, process.env.PADDLE_WEBHOOK_SECRET);

    const req = { headers: { 'paddle-signature': header }, body: Buffer.from(payload) };
    const res = mockRes();

    await paddleWebhookHandler(req, res);

    expect(res.statusCode).toBe(500);
  });
});
