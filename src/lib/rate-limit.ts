import {
  type NextjsApiHandler,
  type NextjsRateLimitOptions,
  withRateLimit,
} from "@universal-rate-limit/nextjs";
import type { ApiErrorCode } from "./api";

const WINDOW_MS = 60_000;

export const RATE_LIMITS = {
  events: {
    limit: 120,
    algorithm: { type: "sliding-window", windowMs: WINDOW_MS },
  },
  event: {
    limit: 120,
    algorithm: { type: "sliding-window", windowMs: WINDOW_MS },
  },
  reservations: {
    limit: 20,
    algorithm: { type: "sliding-window", windowMs: WINDOW_MS },
  },
} as const satisfies Record<string, NextjsRateLimitOptions>;

export const RATE_LIMIT_MESSAGE = {
  error: "Too many requests. Try again later.",
  code: "RATE_LIMITED",
} satisfies { error: string; code: ApiErrorCode };

export function rateLimited<TContext>(
  handler: NextjsApiHandler<TContext>,
  options: NextjsRateLimitOptions,
): (request: Request, context?: TContext) => Promise<Response> {
  return withRateLimit(handler, {
    ...options,
    message: RATE_LIMIT_MESSAGE,
  });
}
