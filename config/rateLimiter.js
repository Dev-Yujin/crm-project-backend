import rateLimit from 'express-rate-limit';

// Broad, coarse protection against a client or bot hammering the GraphQL endpoint —
// generous enough for a busy real admin session, tight enough to blunt real flooding.
// Only mounted in front of the GraphQL POST route in server.js, never on the OAuth
// redirect routes or the Paddle webhook — those have their own traffic shapes and
// existing safeguards (a signed webhook shouldn't ever be blocked by a shared-IP limit).
const rateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

export default rateLimiter;
