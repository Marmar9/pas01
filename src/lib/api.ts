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
