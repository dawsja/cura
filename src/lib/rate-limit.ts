/**
 * Bounded, process-local fixed-window rate limiting. Each limiter keeps a
 * global bucket plus per-client buckets keyed by the caller-supplied client
 * key (see `clientIp` in ./client-ip.ts); the oldest client bucket is evicted once `maxClients` is reached so
 * memory stays bounded under address churn.
 */
type Bucket = { count: number; resetAt: number };

export type RateLimitResult = { allowed: boolean; retryAfter: number };

export interface RateLimiterOptions {
  perClient: number;
  global: number;
  windowMs?: number;
  maxClients?: number;
}

function consume(bucket: Bucket, limit: number, now: number, windowMs: number): RateLimitResult {
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function createRateLimiter(options: RateLimiterOptions): (clientKey: string) => RateLimitResult {
  const windowMs = options.windowMs ?? 60_000;
  const maxClients = options.maxClients ?? 512;
  const clients = new Map<string, Bucket>();
  const globalBucket: Bucket = { count: 0, resetAt: 0 };

  return (clientKey) => {
    const now = Date.now();
    const globalResult = consume(globalBucket, options.global, now, windowMs);
    const key = clientKey.slice(0, 128);
    let bucket = clients.get(key);
    if (!bucket) {
      if (clients.size >= maxClients) clients.delete(clients.keys().next().value as string);
      bucket = { count: 0, resetAt: 0 };
      clients.set(key, bucket);
    }
    const clientResult = consume(bucket, options.perClient, now, windowMs);
    return {
      allowed: globalResult.allowed && clientResult.allowed,
      retryAfter: Math.max(globalResult.retryAfter, clientResult.retryAfter),
    };
  };
}
