import { GraphQLError } from 'graphql';

const attemptsByKey = new Map();

// Cheap, unbiased eviction: on ~1% of calls, walk the map once and drop any key whose
// newest recorded attempt has already fully expired relative to the caller's own
// windowMs — bounds memory under sustained/flooding load (e.g. one-off groupIds or a
// rotating attacker email) without adding real per-call cost to the other 99% of calls.
// windowMs varies per call site, so this only evicts using the windowMs of whichever call
// happens to trigger the sweep — conservative, since a key whose own window is shorter
// than the triggering call's is still definitely stale if its newest timestamp already
// exceeds the triggering call's own window.
const sweepStaleKeys = (now, windowMs) => {
    for (const [k, timestamps] of attemptsByKey) {
        const newest = Math.max(...timestamps);
        if (now - newest >= windowMs) attemptsByKey.delete(k);
    }
};

//In-memory sliding-window limiter. Single-process only — fine for this deployment, but
//won't hold across multiple server instances/restarts. Good enough as a first mitigation
//against credential stuffing on loginMember.
export const checkRateLimit = (
    key,
    { max = 5, windowMs = 15 * 60 * 1000, message = 'Too many attempts. Please try again later.' } = {},
) => {
    const now = Date.now();
    if (Math.random() < 0.01) sweepStaleKeys(now, windowMs);

    const attempts = (attemptsByKey.get(key) ?? []).filter((ts) => now - ts < windowMs);

    if (attempts.length >= max) {
        throw new GraphQLError(message, {
            extensions: { code: 'RATE_LIMITED' },
        });
    }

    attempts.push(now);
    attemptsByKey.set(key, attempts);
};

// Test-only escape hatch. This module holds process-lifetime state (attemptsByKey
// persists for the life of the server), which is exactly right in production but means
// tests that reuse the same rate-limit key across multiple `it()` blocks (e.g. a shared
// fixture groupId) can trip each other's limits depending on run order. Not called from
// any production code path.
export const _resetRateLimitStateForTests = () => {
    if (process.env.NODE_ENV === 'production') {
        console.error('_resetRateLimitStateForTests must never be called in production — ignoring.');
        return;
    }
    attemptsByKey.clear();
};
