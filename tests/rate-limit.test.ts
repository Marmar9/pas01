import { afterEach, describe, expect, test } from "bun:test";
import { MemoryStore } from "@universal-rate-limit/nextjs";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";

const stores: MemoryStore[] = [];

function createLimiter(limit: number) {
  const store = new MemoryStore();

  stores.push(store);

  return rateLimited(async () => Response.json({ ok: true }), {
    limit,
    store,
    algorithm: { type: "sliding-window", windowMs: 60_000 },
    prefix: "test",
  });
}

function requestWithIp(ip: string): Request {
  return new Request("http://localhost/api/events", {
    headers: { "x-forwarded-for": ip },
  });
}

afterEach(() => {
  for (const store of stores) {
    store.shutdown();
  }

  stores.length = 0;
});

describe("rateLimited", () => {
  test("allows requests up to the limit and returns a JSON 429 afterwards", async () => {
    const limiter = createLimiter(2);
    const request = requestWithIp("203.0.113.7");

    expect((await limiter(request)).status).toBe(200);
    expect((await limiter(request)).status).toBe(200);

    const denied = await limiter(request);

    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBeTruthy();
    expect(await denied.json()).toEqual({
      error: "Too many requests. Try again later.",
      code: "RATE_LIMITED",
    });
  });

  test("adds rate limit headers to allowed responses", async () => {
    const limiter = createLimiter(2);
    const response = await limiter(requestWithIp("203.0.113.8"));

    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit")).toContain("limit=2");
    expect(response.headers.get("ratelimit")).toContain("reset=");
  });

  test("keeps buckets isolated per client ip", async () => {
    const limiter = createLimiter(1);

    expect((await limiter(requestWithIp("203.0.113.9"))).status).toBe(200);
    expect((await limiter(requestWithIp("203.0.113.9"))).status).toBe(429);
    expect((await limiter(requestWithIp("198.51.100.4"))).status).toBe(200);
  });

  test("exposes the documented production policies", () => {
    expect(RATE_LIMITS.events.limit).toBe(120);
    expect(RATE_LIMITS.event.limit).toBe(120);
    expect(RATE_LIMITS.reservations.limit).toBe(20);
    expect(RATE_LIMITS.purchase.limit).toBe(20);

    for (const policy of Object.values(RATE_LIMITS)) {
      expect(policy.algorithm).toEqual({
        type: "sliding-window",
        windowMs: 60_000,
      });
    }
  });
});
