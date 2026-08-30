import { GraphQLError } from 'graphql';
import { requireCallerGroupId } from './requireUser.js';
import { isGroupLocked } from '../models/billing.js';

// Mutations that must always work even for a locked group — signing in/out, joining a
// group, and the billing actions themselves (an admin has to be able to pay their way
// out of lockout).
const ALLOWED_WHEN_LOCKED = new Set([
  'registerUser',
  'loginUser',
  'signOutUser',
  'loginMember',
  'logoutMember',
  'joinGroup',
  'createCheckoutSession',
  'createBillingPortalSession',
]);

export function shouldBypassLock(fieldNames) {
  return fieldNames.every((name) => ALLOWED_WHEN_LOCKED.has(name));
}

// Apollo Server plugin: blocks every mutation for a locked group's caller, except the
// allowlisted ones above. Centralized here — specs building on top of this one (seat
// limits, storage, AI-notes metering) never need to add their own lockout check to a
// new resolver, since this plugin already covers every mutation in the schema.
const billingLockPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, contextValue }) {
        if (!operation || operation.operation !== 'mutation') return;

        const fieldNames = operation.selectionSet.selections
          .filter((selection) => selection.kind === 'Field')
          .map((selection) => selection.name.value);

        if (shouldBypassLock(fieldNames)) return;

        let groupId;
        try {
          groupId = requireCallerGroupId(contextValue);
        } catch {
          return; // unauthenticated / no group — the resolver itself enforces auth
        }

        if (await isGroupLocked(groupId)) {
          throw new GraphQLError(
            'This workspace is locked — an admin needs to subscribe to a plan to continue.',
            { extensions: { code: 'BILLING_LOCKED' } },
          );
        }
      },
    };
  },
};

export default billingLockPlugin;
