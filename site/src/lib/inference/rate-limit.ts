import { NextResponse } from "next/server";

type RateLimitBucket = {
  windowStartedAt: number;
  count: number;
};

const globalBucketsKey = "__donkeyInferenceRateLimitBuckets";

type GlobalWithBuckets = typeof globalThis & {
  [globalBucketsKey]?: Map<string, RateLimitBucket>;
};

type RateLimitInput = {
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
};

export function checkInMemoryRateLimit(input: RateLimitInput) {
  const now = input.now ?? Date.now();
  const buckets = rateLimitBuckets();
  const current = buckets.get(input.key);
  if (!current || now - current.windowStartedAt >= input.windowMs) {
    buckets.set(input.key, {
      windowStartedAt: now,
      count: 1,
    });
    pruneBuckets(buckets, now, input.windowMs);
    return {
      ok: true as const,
      remaining: input.limit - 1,
      resetAt: now + input.windowMs,
    };
  }

  if (current.count >= input.limit) {
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((current.windowStartedAt + input.windowMs - now) / 1000)),
      resetAt: current.windowStartedAt + input.windowMs,
    };
  }

  current.count += 1;
  return {
    ok: true as const,
    remaining: input.limit - current.count,
    resetAt: current.windowStartedAt + input.windowMs,
  };
}

export function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: "rate_limited",
      message: "Too many requests. Please retry shortly.",
    },
    {
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
      status: 429,
    },
  );
}

function rateLimitBuckets() {
  const globalWithBuckets = globalThis as GlobalWithBuckets;
  globalWithBuckets[globalBucketsKey] ??= new Map<string, RateLimitBucket>();
  return globalWithBuckets[globalBucketsKey];
}

function pruneBuckets(
  buckets: Map<string, RateLimitBucket>,
  now: number,
  windowMs: number,
) {
  if (buckets.size < 1_000) {
    return;
  }

  const staleBefore = now - windowMs * 2;
  for (const [key, bucket] of buckets) {
    if (bucket.windowStartedAt < staleBefore) {
      buckets.delete(key);
    }
  }
}
