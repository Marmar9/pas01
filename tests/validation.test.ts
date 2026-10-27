import { describe, expect, test } from "bun:test";
import { generateReservationCode } from "@/lib/reservation-code";
import {
  idempotencyKeySchema,
  isSeatInLayout,
  parseSeatId,
  reservationInputSchema,
  toFieldErrors,
} from "@/lib/validation";

describe("reservation input validation", () => {
  test("normalizes seat ids and emails", () => {
    const parsed = reservationInputSchema.parse({
      eventId: " event-1 ",
      seatId: " b7 ",
      customerName: " Ada ",
      email: " Ada@Example.COM ",
    });

    expect(parsed).toEqual({
      eventId: "event-1",
      seatId: "B7",
      customerName: "Ada",
      email: "ada@example.com",
    });
  });

  test("reports field errors", () => {
    const result = reservationInputSchema.safeParse({
      eventId: "",
      seatId: "12",
      customerName: "",
      email: "not-an-email",
    });

    expect(result.success).toBe(false);

    if (result.success) {
      return;
    }

    const details = toFieldErrors(result.error);

    expect(Object.keys(details).sort()).toEqual([
      "customerName",
      "email",
      "eventId",
      "seatId",
    ]);
  });

  test("parses and bounds seats", () => {
    expect(parseSeatId("A2")).toEqual({ row: 0, number: 2 });
    expect(parseSeatId("j14")).toEqual({ row: 9, number: 14 });
    expect(parseSeatId("A0")).toBeNull();
    expect(parseSeatId("1A")).toBeNull();

    const seat = parseSeatId("A14");

    expect(seat).not.toBeNull();

    if (seat) {
      expect(isSeatInLayout(seat, 10, 14)).toBe(true);
      expect(isSeatInLayout(seat, 10, 13)).toBe(false);
      expect(isSeatInLayout(seat, 0, 14)).toBe(false);
    }
  });
});

describe("reservation codes", () => {
  test("generates readable 8 character codes", () => {
    const codes = new Set<string>();

    for (let index = 0; index < 50; index += 1) {
      const code = generateReservationCode();

      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      expect(code).not.toMatch(/[IO01]/);
      codes.add(code);
    }

    expect(codes.size).toBe(50);
  });
});

describe("idempotency keys", () => {
  test("accepts printable keys between 8 and 128 characters", () => {
    expect(idempotencyKeySchema.safeParse("abc-123_XYZ").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("x".repeat(128)).success).toBe(true);
  });

  test("rejects missing, short and non-printable keys", () => {
    expect(idempotencyKeySchema.safeParse(undefined).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("key with spaces").success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse("klucz-zażółć").success).toBe(false);
  });
});
