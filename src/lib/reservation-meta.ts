export type ReservationMeta = {
  eventId: string;
  seatId: string;
};

const STORAGE_PREFIX = "technikino:reservation:";

function isReservationMeta(value: unknown): value is ReservationMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { eventId?: unknown }).eventId === "string" &&
    typeof (value as { seatId?: unknown }).seatId === "string"
  );
}

// The success page only receives the reservation id from Stripe, so keep the
// event/seat labels in session storage to render a complete ticket on return.
export function storeReservationMeta(
  reservationId: string,
  meta: ReservationMeta,
): void {
  try {
    window.sessionStorage.setItem(
      `${STORAGE_PREFIX}${reservationId}`,
      JSON.stringify(meta),
    );
  } catch {
    // Session storage can be unavailable (private mode, quota). The ticket
    // still renders with the code and placeholder details.
  }
}

export function readReservationMeta(
  reservationId: string,
): ReservationMeta | null {
  try {
    const raw = window.sessionStorage.getItem(
      `${STORAGE_PREFIX}${reservationId}`,
    );

    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    return isReservationMeta(parsed)
      ? { eventId: parsed.eventId, seatId: parsed.seatId }
      : null;
  } catch {
    return null;
  }
}
