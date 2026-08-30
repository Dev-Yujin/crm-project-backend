import { parse } from 'graphql';
import { describe, it, expect } from 'vitest';
import { shouldBypassLock, collectMutationFieldNames } from './billingLockPlugin.js';

// Parses a GraphQL document and runs it through the same field-collection path the
// plugin itself uses (document's fragments + the operation's selection set).
function fieldNamesFor(source) {
  const document = parse(source);
  const operation = document.definitions.find((def) => def.kind === 'OperationDefinition');
  const fragmentsByName = new Map(
    document.definitions
      .filter((def) => def.kind === 'FragmentDefinition')
      .map((def) => [def.name.value, def]),
  );
  return [...collectMutationFieldNames(operation.selectionSet, fragmentsByName)];
}

describe('collectMutationFieldNames', () => {
  it('collects a direct top-level field', () => {
    expect(fieldNamesFor('mutation { loginUser(email: "a", password: "b") { user { id } } }')).toEqual([
      'loginUser',
    ]);
  });

  it('resolves a fragment spread wrapping a mutation field', () => {
    const source = `
      mutation { ...Evil }
      fragment Evil on Mutation { addTask(clientId: "1") { id } }
    `;
    expect(fieldNamesFor(source)).toEqual(['addTask']);
  });

  it('resolves an inline fragment wrapping a mutation field', () => {
    const source = 'mutation { ... on Mutation { addTask(clientId: "1") { id } } }';
    expect(fieldNamesFor(source)).toEqual(['addTask']);
  });

  it('does not infinite-loop on a cyclic fragment spread', () => {
    const source = `
      mutation { ...A }
      fragment A on Mutation { ...B addTask(clientId: "1") { id } }
      fragment B on Mutation { ...A }
    `;
    expect(fieldNamesFor(source)).toEqual(['addTask']);
  });
});

describe('shouldBypassLock', () => {
  it('bypasses a single allowlisted mutation', () => {
    expect(shouldBypassLock(['loginUser'])).toBe(true);
  });

  it('bypasses a request naming only allowlisted mutations', () => {
    expect(shouldBypassLock(['createCheckoutSession'])).toBe(true);
  });

  it('does not bypass a non-allowlisted mutation', () => {
    expect(shouldBypassLock(['addTask'])).toBe(false);
  });

  it('does not bypass a mix of allowed and non-allowed mutations', () => {
    expect(shouldBypassLock(['loginUser', 'addTask'])).toBe(false);
  });

  it('treats an empty selection as bypassed (nothing to block)', () => {
    expect(shouldBypassLock([])).toBe(true);
  });
});
