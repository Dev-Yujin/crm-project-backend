import { GraphQLError } from 'graphql';

const attemptsByKey = new Map();

//In-memory sliding-window limiter. Single-process only — fine for this deployment, but
//won't hold across multiple server instances/restarts. Good enough as a first mitigation
//against credential stuffing on loginMember.
export const checkRateLimit = (
    key,
    { max = 5, windowMs = 15 * 60 * 1000, message = 'Too many attempts. Please try again later.' } = {},
) => {
    const now = Date.now();
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
export const _resetRateLimitStateForTests = () => attemptsByKey.clear();
