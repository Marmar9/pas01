"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { StateCard } from "@/components/state-card";
import { ApiError, type EventDto, getEvent } from "@/lib/client-api";
import { isValidSeatId, normalizeSeatId } from "@/lib/seats";
import { ReserveForm } from "./reserve-form";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing"; message: string }
  | { status: "taken"; event: EventDto; seatId: string }
  | { status: "ready"; event: EventDto; seatId: string };

export function ReserveView() {
  const searchParams = useSearchParams();
  const rawEventId = searchParams.get("eventId") ?? "";
  const rawSeatId = searchParams.get("seatId") ?? "";
  const seatId = normalizeSeatId(rawSeatId);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(
    (signal: { active: boolean }) => {
      if (!rawEventId || !isValidSeatId(rawSeatId)) {
        setState({
          status: "missing",
          message:
            "Brakuje seansu lub miejsca. Wróć do repertuaru i wybierz fotel na planie sali.",
        });
        return;
      }

      setState({ status: "loading" });

      getEvent(rawEventId)
        .then((data) => {
          if (!signal.active) {
            return;
          }

          if (data.takenSeats.includes(seatId)) {
            setState({ status: "taken", event: data.event, seatId });
            return;
          }

          setState({ status: "ready", event: data.event, seatId });
        })
        .catch((error: unknown) => {
          if (!signal.active) {
            return;
          }
          setState({
            status: "error",
            message:
              error instanceof ApiError && error.code === "EVENT_NOT_FOUND"
                ? "Ten seans nie jest już dostępny."
                : "Nie udało się wczytać seansu. Spróbuj ponownie.",
          });
        });
    },
    [rawEventId, rawSeatId, seatId],
  );

  useEffect(() => {
    const signal = { active: true };
    load(signal);
    return () => {
      signal.active = false;
    };
  }, [load]);

  if (state.status === "loading") {
    return (
      <StateCard
        icon="spinner"
        title="Przygotowujemy formularz"
        description="Sprawdzamy szczegóły seansu i dostępność fotela."
      />
    );
  }

  if (state.status === "taken") {
    return (
      <StateCard
        icon="warning"
        title="To miejsce jest już zajęte"
        description={`Miejsce ${state.seatId} jest zablokowane lub sprzedane. Blokada może wygasnąć — sprawdź ponownie albo wybierz inny fotel.`}
        action={
          <>
            <button
              type="button"
              onClick={() => load({ active: true })}
              className="btn-primary"
            >
              Sprawdź ponownie
            </button>
            <Link href={`/events/${state.event.id}`} className="btn-ghost">
              Wybierz inne miejsce
            </Link>
          </>
        }
      />
    );
  }

  if (state.status === "missing" || state.status === "error") {
    return (
      <StateCard
        icon="warning"
        title="Nie możemy dokończyć rezerwacji"
        description={state.message}
        action={
          <>
            <Link href="/" className="btn-ghost">
              Wróć do repertuaru
            </Link>
            {state.status === "error" ? (
              <button
                type="button"
                onClick={() => load({ active: true })}
                className="btn-primary"
              >
                Spróbuj ponownie
              </button>
            ) : null}
          </>
        }
      />
    );
  }

  return <ReserveForm event={state.event} seatId={state.seatId} />;
}
