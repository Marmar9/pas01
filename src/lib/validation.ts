import { z } from "zod";

export const SEAT_ID_PATTERN = /^[A-Z]([1-9][0-9]?)$/;

const seatIdSchema = z
  .string()
  .trim()
  .min(1, "Seat is required.")
  .max(3, "Seat is too long.")
  .transform((value) => value.toUpperCase())
  .refine((value) => SEAT_ID_PATTERN.test(value), {
    message: 'Seat must be a row letter followed by a number, e.g. "A2".',
  });

export const reservationInputSchema = z.object({
  eventId: z.string().trim().min(1, "Event is required.").max(64),
  seatId: seatIdSchema,
  customerName: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(100, "Name is too long."),
  email: z
    .string()
    .trim()
    .max(254, "Email is too long.")
    .pipe(z.email("Enter a valid email address."))
    .transform((value) => value.toLowerCase()),
});

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Idempotency key must be at least 8 characters.")
  .max(128, "Idempotency key must be at most 128 characters.")
  .regex(
    /^[\x21-\x7E]+$/,
    "Idempotency key must contain printable ASCII characters only.",
  );

export type ReservationInput = z.infer<typeof reservationInputSchema>;

export type ParsedSeat = {
  row: number;
  number: number;
};

export function parseSeatId(seatId: string): ParsedSeat | null {
  const normalized = seatId.trim().toUpperCase();
  const match = SEAT_ID_PATTERN.exec(normalized);

  if (!match) {
    return null;
  }

  return {
    row: normalized.charCodeAt(0) - "A".charCodeAt(0),
    number: Number(match[1]),
  };
}

export function isSeatInLayout(
  seat: ParsedSeat,
  rows: number,
  seatsPerRow: number,
): boolean {
  return (
    seat.row >= 0 &&
    seat.row < rows &&
    seat.number >= 1 &&
    seat.number <= seatsPerRow
  );
}

export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    details[key] ??= issue.message;
  }

  return details;
}
