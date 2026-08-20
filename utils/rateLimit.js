import { GraphQLError } from 'graphql';

const attemptsByKey = new Map();

//In-memory sliding-window limiter. Single-process only — fine for this deployment, but
//won't hold across multiple server instances/restarts. Good enough as a first mitigation
//against credential stuffing on loginMember.
export const checkRateLimit = (key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) => {
    const now = Date.now();
    const attempts = (attemptsByKey.get(key) ?? []).filter((ts) => now - ts < windowMs);

    if (attempts.length >= max) {
        throw new GraphQLError('Too many attempts. Please try again later.', {
            extensions: { code: 'RATE_LIMITED' },
        });
    }

    attempts.push(now);
    attemptsByKey.set(key, attempts);
};
