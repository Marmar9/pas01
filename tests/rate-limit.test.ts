import { beforeEach, describe, expect, test } from "bun:test";
import {
  checkRateLimit,
  getClientIp,
  RATE_LIMITS,
  resetRateLimitStore,
} from "@/lib/rate-limit";

beforeEach(() => {
  resetRateLimitStore();
});

describe("checkRateLimit", () => {
  test("allows requests up to the limit and rejects the next one", () => {
    const policy = { limit: 3, windowMs: 1_000 };
    const now = 1_000_000;

    expect(checkRateLimit("ip-a", policy, now).allowed).toBe(true);
    expect(checkRateLimit("ip-a", policy, now + 10).allowed).toBe(true);
    const last = checkRateLimit("ip-a", policy, now + 20);

    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);

    const denied = checkRateLimit("ip-a", policy, now + 30);

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("slides the window as old requests expire", () => {
    const policy = { limit: 2, windowMs: 1_000 };
    const now = 1_000_000;

    checkRateLimit("ip-b", policy, now);
    checkRateLimit("ip-b", policy, now + 100);

    expect(checkRateLimit("ip-b", policy, now + 200).allowed).toBe(false);
    expect(checkRateLimit("ip-b", policy, now + 1_001).allowed).toBe(true);
  });

  test("keeps buckets isolated per key", () => {
    const policy = { limit: 1, windowMs: 1_000 };

    expect(checkRateLimit("ip-c", policy, 1_000).allowed).toBe(true);
    expect(checkRateLimit("ip-c", policy, 1_001).allowed).toBe(false);
    expect(checkRateLimit("ip-d", policy, 1_001).allowed).toBe(true);
  });

  test("exposes production policies", () => {
    expect(RATE_LIMITS.events.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.event.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.reservations.limit).toBeGreaterThan(0);
  });
});

describe("getClientIp", () => {
  function requestWith(headers: Record<string, string>): Request {
    return new Request("http://localhost/api/events", { headers });
  }

  test("uses the first forwarded address", () => {
    expect(
      getClientIp(requestWith({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    ).toBe("203.0.113.7");
  });

  test("falls back to x-real-ip", () => {
    expect(getClientIp(requestWith({ "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
  });

  test("falls back to a shared unknown bucket", () => {
    expect(getClientIp(requestWith({}))).toBe("unknown");
  });
});
