import { createRateLimiter } from './rate-limit';

/** Bounded process-local protection for public setup mutations and bcrypt token checks. */
export const checkSetupRateLimit = createRateLimiter({ perClient: 10, global: 30 });
