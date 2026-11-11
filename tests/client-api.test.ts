import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  createReservation,
  getEvent,
  getEvents,
  getLoyalty,
  getReservation,
  purchaseReservation,
  startCheckout,
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

      return jsonResponse(
        {
          reservationId: "res-1",
          amount: 3200,
          expiresAt: "2026-10-28T12:15:00.000Z",
        },
        201,
      );
    }) as typeof fetch;

    const result = await createReservation(reservationInput, "key-12345678");

    expect(result).toEqual({
      reservationId: "res-1",
      amount: 3200,
      expiresAt: "2026-10-28T12:15:00.000Z",
    });
    expect(calls).toBe(4);
    expect(new Set(seenKeys).size).toBe(1);
    expect(seenKeys[0]).toBe("key-12345678");
  }, 10000);

  test("purchases a reservation and retries network failures", async () => {
    let calls = 0;

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;

      expect(String(input)).toBe("/api/reservations/res-1/purchase");
      expect(init?.method).toBe("POST");

      if (calls < 2) {
        throw new TypeError("Failed to fetch");
      }

      return jsonResponse({ code: "ABC12345" });
    }) as typeof fetch;

    const result = await purchaseReservation("res-1");

    expect(result).toEqual({ code: "ABC12345" });
    expect(calls).toBe(2);
  }, 10000);

  test("exposes reservation purchase errors", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        { error: "Reservation has expired.", code: "RESERVATION_EXPIRED" },
        410,
      )) as typeof fetch;

    const error = await purchaseReservation("res-1").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(410);
    expect(error.code).toBe("RESERVATION_EXPIRED");
  });

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

  test("reads a reservation state", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/reservations/res-1");

      return jsonResponse({
        status: "paid",
        amount: 3200,
        expiresAt: "2026-10-28T12:15:00.000Z",
        code: "ABC12345",
        pointsUsed: 0,
        pointsEarned: 0,
      });
    }) as typeof fetch;

    const result = await getReservation("res-1");

    expect(result).toEqual({
      status: "paid",
      amount: 3200,
      expiresAt: "2026-10-28T12:15:00.000Z",
      code: "ABC12345",
      pointsUsed: 0,
      pointsEarned: 0,
    });
  });

  test("keeps a held reservation without a code", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        status: "held",
        amount: 3200,
        expiresAt: "2026-10-28T12:15:00.000Z",
        pointsUsed: 0,
      })) as typeof fetch;

    const result = await getReservation("res-1");

    expect(result.code).toBeUndefined();
  });

  test("rejects malformed reservation states", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ status: "unknown", amount: 3200 })) as typeof fetch;

    const error = await getReservation("res-1").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  test("starts a checkout session and returns the Stripe url", async () => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("/api/reservations/res-1/checkout");
      expect(init?.method).toBe("POST");

      return jsonResponse({ url: "https://checkout.stripe.com/cs_test_1" });
    }) as typeof fetch;

    const result = await startCheckout("res-1");

    expect(result).toEqual({ url: "https://checkout.stripe.com/cs_test_1" });
  });

  test("exposes checkout refusals", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        {
          error: "Online payments are temporarily unavailable.",
          code: "PAYMENT_UNAVAILABLE",
        },
        503,
      )) as typeof fetch;

    const error = await startCheckout("res-1").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(503);
    expect(error.code).toBe("PAYMENT_UNAVAILABLE");
  });

  test("fetches a loyalty balance", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/loyalty?email=jan%40example.com");
      return jsonResponse({ email: "jan@example.com", points: 1000 });
    }) as typeof fetch;

    expect(await getLoyalty("jan@example.com")).toEqual({
      email: "jan@example.com",
      points: 1000,
    });
  });

  test("rejects a malformed loyalty balance", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        email: "jan@example.com",
        points: "1000",
      })) as typeof fetch;

    const error = await getLoyalty("jan@example.com").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("INVALID_RESPONSE");
  });

  test("sends points only when supplied", async () => {
    const bodies: Array<string | undefined> = [];

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      bodies.push(init?.body as string | undefined);
      return jsonResponse({ url: "https://checkout.stripe.com/cs_test_1" });
    }) as typeof fetch;

    await startCheckout("res-1", 1000);
    await startCheckout("res-1");

    expect(bodies).toEqual(['{"points":1000}', undefined]);
  });

  test("reads the points split from a reservation", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        status: "paid",
        amount: 3200,
        expiresAt: "2026-10-28T12:15:00.000Z",
        code: "ABC12345",
        pointsUsed: 1000,
        pointsEarned: 220,
      })) as typeof fetch;

    const result = await getReservation("res-1");

    expect(result.pointsUsed).toBe(1000);
    expect(result.pointsEarned).toBe(220);
  });

  test("exposes loyalty checkout refusals", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(
        { error: "Not enough loyalty points.", code: "INSUFFICIENT_POINTS" },
        409,
      )) as typeof fetch;

    const error = await startCheckout("res-1", 1000).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("INSUFFICIENT_POINTS");
  });
});
