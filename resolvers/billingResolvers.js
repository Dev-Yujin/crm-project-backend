import { GraphQLError } from 'graphql';
import { requireGroup, requireCallerGroupId } from '../utils/requireUser.js';
import { PLANS, planLimitsResponse } from '../config/plans.js';
import { paddle } from '../config/paddle.js';
import { getOrCreateBilling, getPaddleBillingIds } from '../models/billing.js';
import { getOrCreateStorageUsage } from '../models/storage.js';

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
    createBillingPortalSession: async (_, __, context) => {
      const groupId = requireGroup(context);
      const { customerId, subscriptionId } = await getPaddleBillingIds(groupId);

      if (!customerId) {
        throw new GraphQLError('Choose a plan before managing billing.', {
          extensions: { code: 'NO_PADDLE_CUSTOMER' },
        });
      }

      const session = await paddle.customerPortalSessions.create(
        customerId,
        subscriptionId ? [subscriptionId] : [],
      );

      return { url: session.urls.general.overview };
    },
  },
};

export default billingResolvers;
