export type RateLimitPolicy = {
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
};

export const RATE_LIMITS = {
  events: { limit: 120, windowMs: 60_000 },
  event: { limit: 120, windowMs: 60_000 },
  reservations: { limit: 20, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>;

const buckets = new Map<string, number[]>();
const MAX_BUCKETS = 10_000;

let checksSincePrune = 0;

export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const forwardedIp = forwardedFor?.split(",")[0]?.trim();

  if (forwardedIp) {
    return forwardedIp;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();

  return realIp || "unknown";
}

export function checkRateLimit(
  key: string,
  policy: RateLimitPolicy,
  now = Date.now(),
): RateLimitResult {
  const windowStart = now - policy.windowMs;
  const timestamps = (buckets.get(key) ?? []).filter(
    (timestamp) => timestamp > windowStart,
  );

  if (timestamps.length >= policy.limit) {
    const resetAt = (timestamps[0] ?? now) + policy.windowMs;

    buckets.set(key, timestamps);

    return {
      allowed: false,
      limit: policy.limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      resetAt,
    };
  }

  timestamps.push(now);
  buckets.set(key, timestamps);
  pruneBuckets(now, policy.windowMs);

  return {
    allowed: true,
    limit: policy.limit,
    remaining: policy.limit - timestamps.length,
    retryAfterSeconds: 0,
    resetAt: now + policy.windowMs,
  };
}

export function resetRateLimitStore(): void {
  buckets.clear();
  checksSincePrune = 0;
}

function pruneBuckets(now: number, windowMs: number): void {
  checksSincePrune += 1;

  if (checksSincePrune < 1000 && buckets.size <= MAX_BUCKETS) {
    return;
  }

  checksSincePrune = 0;

  for (const [key, timestamps] of buckets) {
    const active = timestamps.filter((timestamp) => timestamp > now - windowMs);

    if (active.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, active);
    }
  }
}
