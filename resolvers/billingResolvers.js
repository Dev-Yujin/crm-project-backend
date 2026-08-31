import { GraphQLError } from 'graphql';
import { requireGroup, requireCallerGroupId } from '../utils/requireUser.js';
import { PLANS, planLimitsResponse } from '../config/plans.js';
import { stripe } from '../config/stripe.js';
import {
  getOrCreateBilling,
  getOrCreateStripeCustomerId,
  getStripeCustomerId,
} from '../models/billing.js';
import { getOrCreateStorageUsage } from '../models/storage.js';

function frontendOrigin() {
  return (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173').split(',')[0].trim();
}

const billingResolvers = {
  Query: {
    myBilling: async (_, __, context) => {
      const groupId = requireCallerGroupId(context);
      const [billing, storageBytesUsed] = await Promise.all([
        getOrCreateBilling(groupId),
        getOrCreateStorageUsage(groupId),
      ]);
      return { ...billing, storageBytesUsed };
    },
    plans: () => Object.keys(PLANS).map(planLimitsResponse),
  },
  Mutation: {
    createCheckoutSession: async (_, { plan }, context) => {
      const groupId = requireGroup(context);
      const planKey = plan.toLowerCase();

      if (!PLANS[planKey]) {
        throw new GraphQLError('Unknown plan', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      const billing = await getOrCreateBilling(groupId);
      if (billing.plan && billing.status !== 'canceled') {
        throw new GraphQLError(
          'This workspace already has an active subscription. Use "Manage billing" to change plans.',
          { extensions: { code: 'ALREADY_SUBSCRIBED' } },
        );
      }

      const customerId = await getOrCreateStripeCustomerId(groupId, async () => {
        const customer = await stripe.customers.create({ metadata: { groupId } });
        return customer.id;
      });

      const origin = frontendOrigin();
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: PLANS[planKey].stripePriceId, quantity: 1 }],
        success_url: `${origin}/app/billing?checkout=success`,
        cancel_url: `${origin}/app/billing?checkout=cancel`,
        subscription_data: { metadata: { groupId } },
        allow_promotion_codes: true,
      });

      return { url: session.url };
    },
    createBillingPortalSession: async (_, __, context) => {
      const groupId = requireGroup(context);
      const customerId = await getStripeCustomerId(groupId);

      if (!customerId) {
        throw new GraphQLError('Choose a plan before managing billing.', {
          extensions: { code: 'NO_STRIPE_CUSTOMER' },
        });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${frontendOrigin()}/app/billing`,
      });

      return { url: portalSession.url };
    },
  },
};

export default billingResolvers;
