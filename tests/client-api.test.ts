import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  createReservation,
  getEvent,
  getEvents,
} from "@/lib/client-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const reservationInput = {
  eventId: "event-dune",
  seatId: "A2",
  customerName: "Jan Kowalski",
  email: "jan@example.com",
};

describe("client api", () => {
  test("retries network failures and reuses the idempotency key", async () => {
    let calls = 0;
    const seenKeys: string[] = [];

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;
      seenKeys.push(
        (init?.headers as Record<string, string>)["Idempotency-Key"],
      );

      if (calls < 4) {
        throw new TypeError("Failed to fetch");
      }

      return jsonResponse({ reservationId: "res-1", code: "ABC123" }, 201);
    }) as typeof fetch;

    const result = await createReservation(reservationInput, "key-12345678");

    expect(result).toEqual({ reservationId: "res-1", code: "ABC123" });
    expect(calls).toBe(4);
    expect(new Set(seenKeys).size).toBe(1);
    expect(seenKeys[0]).toBe("key-12345678");
  }, 10000);

  test("does not retry validation errors and exposes details", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse(
        {
          error: "Nieprawidłowe dane",
          code: "VALIDATION_ERROR",
          details: { email: "Podaj e-mail" },
        },
        400,
      );
    }) as typeof fetch;

    const error = await createReservation(
      reservationInput,
      "key-12345678",
    ).catch((caught) => caught);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toEqual({ email: "Podaj e-mail" });
  });

  test("rejects non-json responses", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;

    const error = await getEvents().catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  test("reads retry-after from rate limited responses", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: "Za dużo żądań", code: "RATE_LIMITED" }, 429, {
        "Retry-After": "30",
      })) as typeof fetch;

    const error = await getEvent("event-dune").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfter).toBe(30);
  }, 10000);

  test("gives up after three retries", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const error = await getEvents().catch((caught) => caught);

    expect(calls).toBe(4);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("NETWORK_ERROR");
  }, 10000);

  test("unwraps event payloads", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        event: {
          id: "event-dune",
          title: "Dune",
          description: "opis",
          venue: "Sala 1",
          startsAt: "2026-11-05T19:00:00.000Z",
          rows: 10,
          seatsPerRow: 14,
        },
        takenSeats: ["A2"],
      })) as typeof fetch;

    const result = await getEvent("event-dune");

    expect(result.event.id).toBe("event-dune");
    expect(result.takenSeats).toEqual(["A2"]);
  });
});
