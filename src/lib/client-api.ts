export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "EVENT_NOT_FOUND"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_EXPIRED"
  | "SEAT_TAKEN"
  | "IDEMPOTENCY_KEY_REUSED"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

export type EventDto = {
  id: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  rows: number;
  seatsPerRow: number;
};

export type EventWithTakenSeats = {
  event: EventDto;
  takenSeats: string[];
};

export type ReservationInput = {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
};

export type ReservationResult = {
  reservationId: string;
  expiresAt: string;
};

export type PurchaseResult = {
  code: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, string>;
  readonly retryAfter?: number;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: { details?: Record<string, string>; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}

const REQUEST_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [300, 600, 1200];

type ErrorPayload = {
  error?: unknown;
  code?: unknown;
  details?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toDetails(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const details: Record<string, string> = {};
  for (const [key, message] of Object.entries(value)) {
    if (typeof message === "string") {
      details[key] = message;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function toErrorCode(value: unknown): ApiErrorCode {
  const codes: ApiErrorCode[] = [
    "VALIDATION_ERROR",
    "EVENT_NOT_FOUND",
    "RESERVATION_NOT_FOUND",
    "RESERVATION_EXPIRED",
    "SEAT_TAKEN",
    "IDEMPOTENCY_KEY_REUSED",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
  ];

  return codes.find((code) => code === value) ?? "INTERNAL_ERROR";
}

function readRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");

  if (header === null) {
    return undefined;
  }

  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "INVALID_RESPONSE",
      "Serwer zwrócił nieczytelną odpowiedź. Spróbuj ponownie.",
    );
  }
}

function toApiError(response: Response, payload: unknown): ApiError {
  const body: ErrorPayload = isRecord(payload) ? payload : {};
  const message =
    typeof body.error === "string"
      ? body.error
      : "Coś poszło nie tak. Spróbuj ponownie.";

  return new ApiError(response.status, toErrorCode(body.code), message, {
    details: toDetails(body.details),
    retryAfter: readRetryAfter(response),
  });
}

async function attemptRequest<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    const payload = await readJson(response);

    if (!response.ok) {
      throw toApiError(response, payload);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Nie udało się połączyć z serwerem. Sprawdź połączenie i spróbuj ponownie.",
    );
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let lastError: ApiError | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await attemptRequest<T>(path, init);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "NETWORK_ERROR") {
        throw error;
      }

      lastError = error;
      const delay = RETRY_DELAYS_MS[attempt];

      if (delay === undefined) {
        break;
      }

      await sleep(delay);
    }
  }

  throw (
    lastError ??
    new ApiError(0, "NETWORK_ERROR", "Nie udało się połączyć z serwerem.")
  );
}

export async function getEvents(): Promise<EventDto[]> {
  const payload = await requestJson<{ events?: unknown }>("/api/events");

  if (!isRecord(payload) || !Array.isArray(payload.events)) {
    throw new ApiError(
      200,
      "INVALID_RESPONSE",
      "Serwer zwrócił nieoczekiwaną listę seansów.",
    );
  }

  return payload.events as EventDto[];
}

export async function getEvent(eventId: string): Promise<EventWithTakenSeats> {
  const payload = await requestJson<{ event?: unknown; takenSeats?: unknown }>(
    `/api/events/${encodeURIComponent(eventId)}`,
  );

  if (
    !isRecord(payload) ||
    !isRecord(payload.event) ||
    !Array.isArray(payload.takenSeats)
  ) {
    throw new ApiError(
      200,
      "INVALID_RESPONSE",
      "Serwer zwrócił nieoczekiwane dane seansu.",
    );
  }

  return {
    event: payload.event as EventDto,
    takenSeats: payload.takenSeats.filter(
      (seat): seat is string => typeof seat === "string",
    ),
  };
}

export async function createReservation(
  input: ReservationInput,
  idempotencyKey: string,
): Promise<ReservationResult> {
  const payload = await requestJson<{
    reservationId?: unknown;
    expiresAt?: unknown;
  }>("/api/reservations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });

  if (
    !isRecord(payload) ||
    typeof payload.reservationId !== "string" ||
    typeof payload.expiresAt !== "string"
  ) {
    throw new ApiError(
      200,
      "INVALID_RESPONSE",
      "Serwer nie zwrócił danych rezerwacji.",
    );
  }

  return {
    reservationId: payload.reservationId,
    expiresAt: payload.expiresAt,
  };
}

export async function purchaseReservation(
  reservationId: string,
): Promise<PurchaseResult> {
  const payload = await requestJson<{ code?: unknown }>(
    `/api/reservations/${encodeURIComponent(reservationId)}/purchase`,
    { method: "POST" },
  );

  if (!isRecord(payload) || typeof payload.code !== "string") {
    throw new ApiError(
      200,
      "INVALID_RESPONSE",
      "Serwer nie zwrócił kodu rezerwacji.",
    );
  }

  return { code: payload.code };
}
