import { connection } from "next/server";
import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";
import { getReservationState } from "@/lib/reservations";

async function handler(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();

  const { id } = await context.params;

  try {
    const state = getReservationState(getDb(), id);

    if (!state) {
      return errorResponse(
        404,
        "RESERVATION_NOT_FOUND",
        "Reservation not found.",
      );
    }

    return Response.json({
      status: state.status,
      amount: state.amount,
      expiresAt: state.expiresAt,
      ...(state.code ? { code: state.code } : {}),
    });
  } catch (error) {
    console.error("Failed to load reservation:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export const GET = rateLimited(handler, RATE_LIMITS.reservation);
