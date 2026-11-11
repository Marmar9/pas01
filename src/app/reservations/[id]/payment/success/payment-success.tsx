"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PurchaseSummary } from "@/components/purchase-summary";
import { StateCard } from "@/components/state-card";
import {
  ApiError,
  getReservation,
  type ReservationState,
} from "@/lib/client-api";
import { formatCountdown, formatPrice } from "@/lib/format";
import { cardAmountFor } from "@/lib/loyalty-points";
import {
  type ReservationMeta,
  readReservationMeta,
} from "@/lib/reservation-meta";
import { Confirmation } from "../../confirmation";

type PaidReservation = ReservationState & { code: string };

type PaymentState =
  | { status: "loading" }
  | { status: "pending"; reservation: ReservationState }
  | { status: "paid"; reservation: PaidReservation }
  | { status: "expired"; amount: number; pointsUsed: number }
  | { status: "not-found" }
  | { status: "error"; message: string };

const POLL_INTERVAL_MS = 2000;

export function PaymentSuccess({ reservationId }: { reservationId: string }) {
  const [state, setState] = useState<PaymentState>({ status: "loading" });
  const [meta, setMeta] = useState<ReservationMeta | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pollTimer = useRef<number | null>(null);
  const knownExpiry = useRef<number | null>(null);
  const knownAmount = useRef<number | null>(null);
  const knownPoints = useRef<number>(0);

  const check = useCallback(async () => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }

    try {
      const reservation = await getReservation(reservationId);

      if (reservation.status === "paid") {
        if (!reservation.code) {
          setState({
            status: "error",
            message:
              "Płatność została potwierdzona, ale nie udało się odczytać kodu biletu. Skontaktuj się z nami.",
          });
          return;
        }

        setState({
          status: "paid",
          reservation: { ...reservation, code: reservation.code },
        });
        return;
      }

      const expiresAt = Date.parse(reservation.expiresAt);

      if (
        reservation.status === "expired" ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        setState({
          status: "expired",
          amount: reservation.amount,
          pointsUsed: reservation.pointsUsed,
        });
        return;
      }

      knownExpiry.current = expiresAt;
      knownAmount.current = reservation.amount;
      knownPoints.current = reservation.pointsUsed;
      setState({ status: "pending", reservation });
      pollTimer.current = window.setTimeout(() => {
        void check();
      }, POLL_INTERVAL_MS);
    } catch (error) {
      if (error instanceof ApiError && error.code === "RESERVATION_NOT_FOUND") {
        setState({ status: "not-found" });
        return;
      }

      const expiry = knownExpiry.current;

      if (expiry !== null && expiry <= Date.now()) {
        setState({
          status: "expired",
          amount: knownAmount.current ?? 0,
          pointsUsed: knownPoints.current,
        });
        return;
      }

      // The hold is still valid, so keep polling after a transient failure.
      pollTimer.current = window.setTimeout(() => {
        void check();
      }, POLL_INTERVAL_MS);
    }
  }, [reservationId]);

  useEffect(() => {
    setMeta(readReservationMeta(reservationId));
  }, [reservationId]);

  useEffect(() => {
    void check();

    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
      }
    };
  }, [check]);

  useEffect(() => {
    if (state.status !== "pending") {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.status]);

  if (state.status === "loading") {
    return (
      <div className="container-page pb-24 pt-32">
        <StateCard
          icon="spinner"
          title="Sprawdzamy płatność"
          description="Stripe potwierdza Twoją płatność. To zwykle kilka sekund."
        />
      </div>
    );
  }

  if (state.status === "paid") {
    return (
      <Confirmation
        code={state.reservation.code}
        eventId={meta?.eventId}
        seatId={meta?.seatId}
        summary={{
          amount: state.reservation.amount,
          pointsUsed: state.reservation.pointsUsed,
          pointsEarned: state.reservation.pointsEarned,
        }}
      />
    );
  }

  if (state.status === "pending") {
    const remaining = Math.max(
      0,
      Date.parse(state.reservation.expiresAt) - now,
    );
    const cardAmount = cardAmountFor(
      state.reservation.amount,
      state.reservation.pointsUsed,
    );

    return (
      <div className="container-page pb-24 pt-28 sm:pt-32">
        <StateCard
          icon="spinner"
          title="Płatność w toku…"
          description={`Stripe potwierdza płatność ${formatPrice(
            cardAmount,
          )}. Ta strona odświeży się automatycznie, gdy bilet będzie gotowy.`}
          action={
            <span
              role="timer"
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-zinc-300"
            >
              Rezerwacja ważna jeszcze {formatCountdown(remaining)}
            </span>
          }
        />
        <div className="mx-auto max-w-xl">
          <PurchaseSummary
            amount={state.reservation.amount}
            pointsUsed={state.reservation.pointsUsed}
          />
        </div>
        <p className="mx-auto mt-6 max-w-md text-center text-xs text-zinc-500">
          Nie zamykaj tej strony. Jeśli płatność została przerwana, możesz
          wrócić i spróbować ponownie, dopóki rezerwacja jest ważna.
        </p>
      </div>
    );
  }

  if (state.status === "expired") {
    return (
      <div className="container-page pb-24 pt-28 sm:pt-32">
        <StateCard
          icon="warning"
          title="Rezerwacja wygasła"
          description={`Nie potwierdziliśmy płatności ${formatPrice(
            cardAmountFor(state.amount, state.pointsUsed),
          )} przed upływem ważności rezerwacji. Miejsce zostało zwolnione.`}
          action={
            <Link href="/" className="btn-primary">
              Wróć do repertuaru
            </Link>
          }
        />
      </div>
    );
  }

  if (state.status === "not-found") {
    return (
      <div className="container-page pb-24 pt-28 sm:pt-32">
        <StateCard
          icon="warning"
          title="Nie znaleźliśmy rezerwacji"
          description="Link do płatności jest nieprawidłowy albo rezerwacja została usunięta."
          action={
            <Link href="/" className="btn-primary">
              Wróć do repertuaru
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="container-page pb-24 pt-28 sm:pt-32">
      <StateCard
        icon="warning"
        title="Nie udało się sprawdzić płatności"
        description={state.message}
        action={
          <>
            <button
              type="button"
              onClick={() => {
                setState({ status: "loading" });
                void check();
              }}
              className="btn-primary"
            >
              Spróbuj ponownie
            </button>
            <Link href="/" className="btn-ghost">
              Wróć do repertuaru
            </Link>
          </>
        }
      />
    </div>
  );
}
