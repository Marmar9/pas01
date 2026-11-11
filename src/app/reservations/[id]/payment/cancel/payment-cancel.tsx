"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PurchaseSummary } from "@/components/purchase-summary";
import { StateCard } from "@/components/state-card";
import {
  ApiError,
  getReservation,
  type ReservationState,
  startCheckout,
} from "@/lib/client-api";
import { formatCountdown, formatPrice } from "@/lib/format";
import { cardAmountFor } from "@/lib/loyalty-points";
import { Confirmation } from "../../confirmation";

type PaidReservation = ReservationState & { code: string };

type CancelState =
  | { status: "loading" }
  | { status: "held"; reservation: ReservationState }
  | { status: "paid"; reservation: PaidReservation }
  | { status: "expired"; amount: number; pointsUsed: number }
  | { status: "not-found" }
  | { status: "error"; message: string };

export function PaymentCancel({ reservationId }: { reservationId: string }) {
  const [state, setState] = useState<CancelState>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    setNotice(null);

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

      setState({ status: "held", reservation });
    } catch (error) {
      if (error instanceof ApiError && error.code === "RESERVATION_NOT_FOUND") {
        setState({ status: "not-found" });
        return;
      }

      setState({
        status: "error",
        message:
          "Nie udało się sprawdzić rezerwacji. Sprawdź połączenie i spróbuj ponownie.",
      });
    }
  }, [reservationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.status !== "held") {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    if (
      state.status === "held" &&
      Date.parse(state.reservation.expiresAt) <= now
    ) {
      setState({
        status: "expired",
        amount: state.reservation.amount,
        pointsUsed: state.reservation.pointsUsed,
      });
    }
  }, [state, now]);

  async function payAgain() {
    if (state.status !== "held" || pending) {
      return;
    }

    const lockedPoints = state.reservation.pointsUsed;
    setPending(true);
    setNotice(null);

    try {
      const checkout = await startCheckout(
        reservationId,
        lockedPoints > 0 ? lockedPoints : undefined,
      );
      window.location.assign(checkout.url);
    } catch (error) {
      if (error instanceof ApiError) {
        if (
          error.code === "RESERVATION_EXPIRED" ||
          error.code === "RESERVATION_ALREADY_PAID"
        ) {
          await load();
          return;
        }

        if (
          error.code === "INSUFFICIENT_POINTS" ||
          error.code === "POINTS_LIMIT_EXCEEDED"
        ) {
          await load();
          setNotice(
            "Saldo punktów się zmieniło. Kwota została zaktualizowana — spróbuj ponownie.",
          );
          return;
        }

        if (error.code === "PAYMENT_UNAVAILABLE") {
          setState({
            status: "error",
            message:
              "Płatności online są chwilowo niedostępne. Spróbuj ponownie za chwilę.",
          });
          return;
        }

        if (error.code === "LOYALTY_UNAVAILABLE") {
          await load();
          setNotice(
            "Program lojalnościowy jest chwilowo niedostępny. Spróbuj ponownie, aby zapłacić kartą.",
          );
          return;
        }
      }

      setState({
        status: "error",
        message: "Nie udało się rozpocząć płatności. Spróbuj ponownie.",
      });
    } finally {
      setPending(false);
    }
  }

  if (state.status === "loading") {
    return (
      <div className="container-page pb-24 pt-32">
        <StateCard
          icon="spinner"
          title="Sprawdzamy rezerwację"
          description="Za chwilę pokażemy status płatności."
        />
      </div>
    );
  }

  if (state.status === "paid") {
    return (
      <Confirmation
        code={state.reservation.code}
        summary={{
          amount: state.reservation.amount,
          pointsUsed: state.reservation.pointsUsed,
          pointsEarned: state.reservation.pointsEarned,
        }}
      />
    );
  }

  if (state.status === "held") {
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
          icon="warning"
          title="Płatność została przerwana"
          description={`Twoje miejsce nadal czeka. Możesz zapłacić ${formatPrice(
            cardAmount,
          )} ponownie, dopóki rezerwacja jest ważna.`}
          action={
            <>
              <button
                type="button"
                onClick={() => void payAgain()}
                disabled={pending}
                className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending
                  ? "Przekierowujemy…"
                  : `Zapłać ${formatPrice(cardAmount)}`}
              </button>
              <Link href="/" className="btn-ghost">
                Wróć do repertuaru
              </Link>
            </>
          }
        />
        {notice ? (
          <output className="mx-auto mt-6 block max-w-md rounded-xl border border-secondary/30 bg-secondary/10 px-4 py-3 text-center text-sm text-white">
            {notice}
          </output>
        ) : null}
        <div className="mx-auto max-w-xl">
          <PurchaseSummary
            amount={state.reservation.amount}
            pointsUsed={state.reservation.pointsUsed}
          />
        </div>
        <p className="mx-auto mt-6 max-w-md text-center text-xs text-zinc-500">
          Rezerwacja wygaśnie za {formatCountdown(remaining)}.
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
          description={`Czas na opłacenie ${formatPrice(
            cardAmountFor(state.amount, state.pointsUsed),
          )} minął, więc miejsce zostało zwolnione.`}
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
        title="Nie udało się sprawdzić rezerwacji"
        description={state.message}
        action={
          <>
            <button
              type="button"
              onClick={() => void load()}
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
