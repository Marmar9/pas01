import type { RateLimitResult } from "./rate-limit";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "EVENT_NOT_FOUND"
  | "SEAT_TAKEN"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, string>,
): Response {
  return Response.json(
    {
      error: message,
      code,
      ...(details && Object.keys(details).length > 0 ? { details } : {}),
    },
    { status },
  );
}

export function rateLimitResponse(result: RateLimitResult): Response {
  return Response.json(
    {
      error: "Too many requests. Try again later.",
      code: "RATE_LIMITED",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "RateLimit-Limit": String(result.limit),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    },
  );
}
