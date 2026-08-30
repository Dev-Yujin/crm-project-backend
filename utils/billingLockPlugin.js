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

// Collects every top-level mutation field actually being executed, resolving
// FragmentSpread/InlineFragment against the document's fragment definitions. A naive
// `selectionSet.selections.filter(kind === 'Field')` misses a request shaped like
// `mutation { ...Evil } fragment Evil on Mutation { deleteTask(...) }` — that selection
// set has zero direct Field nodes, so an unresolved check would see an empty list and
// (since shouldBypassLock([]) is true — nothing to block) let the mutation straight
// through. This is the schema's only lockout enforcement point, so that gap is a full
// bypass, not a cosmetic one.
export function collectMutationFieldNames(selectionSet, fragmentsByName, seenFragments = new Set()) {
  const fieldNames = new Set();

  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      fieldNames.add(selection.name.value);
    } else if (selection.kind === 'InlineFragment') {
      for (const name of collectMutationFieldNames(selection.selectionSet, fragmentsByName, seenFragments)) {
        fieldNames.add(name);
      }
    } else if (selection.kind === 'FragmentSpread') {
      const fragmentName = selection.name.value;
      if (seenFragments.has(fragmentName)) continue; // guard against cyclic fragments
      seenFragments.add(fragmentName);
      const fragment = fragmentsByName.get(fragmentName);
      if (!fragment) continue; // invalid document — validation already rejects this before this hook runs
      for (const name of collectMutationFieldNames(fragment.selectionSet, fragmentsByName, seenFragments)) {
        fieldNames.add(name);
      }
    }
  }

  return fieldNames;
}

// Apollo Server plugin: blocks every mutation for a locked group's caller, except the
// allowlisted ones above. Centralized here — specs building on top of this one (seat
// limits, storage, AI-notes metering) never need to add their own lockout check to a
// new resolver, since this plugin already covers every mutation in the schema.
const billingLockPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ operation, document, contextValue }) {
        if (!operation || operation.operation !== 'mutation') return;

        const fragmentsByName = new Map(
          document.definitions
            .filter((def) => def.kind === 'FragmentDefinition')
            .map((def) => [def.name.value, def]),
        );
        const fieldNames = [...collectMutationFieldNames(operation.selectionSet, fragmentsByName)];

        if (shouldBypassLock(fieldNames)) return;

        let groupId;
        try {
          groupId = requireCallerGroupId(contextValue);
        } catch (err) {
          // Only the two auth errors requireCallerGroupId can throw mean "not locked
          // here, the resolver enforces its own auth." Anything else (e.g. a future
          // change to that helper that can throw for an unrelated reason) must not be
          // silently treated as "let it through" — re-throw so it surfaces as a real
          // error instead of masking as a lockout bypass.
          const code = err instanceof GraphQLError ? err.extensions?.code : undefined;
          if (code === 'UNAUTHENTICATED' || code === 'NO_GROUP') return;
          throw err;
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
