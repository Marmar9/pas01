"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EventPoster } from "@/components/event-poster";
import { SeatMap } from "@/components/seat-map";
import { StateCard } from "@/components/state-card";
import { ApiError, type EventDto, getEvent } from "@/lib/client-api";
import { formatEventDate, formatEventWeekday } from "@/lib/format";
import { countFreeSeats } from "@/lib/seats";

type DetailState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; event: EventDto; takenSeats: string[] };

export function EventDetail({ eventId }: { eventId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });

    try {
      const result = await getEvent(eventId);
      setState({
        status: "ready",
        event: result.event,
        takenSeats: result.takenSeats,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "EVENT_NOT_FOUND") {
        setState({ status: "not-found" });
        return;
      }

      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Nie udało się pobrać seansu.",
      });
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="container-page pb-24 pt-28 sm:pt-32">
      <nav
        aria-label="Ścieżka nawigacji"
        className="mb-8 text-xs text-zinc-500"
      >
        <Link
          href="/"
          className="transition-colors hover:text-white focus-ring rounded-md"
        >
          Repertuar
        </Link>
        <span aria-hidden="true" className="mx-2">
          /
        </span>
        <span className="text-zinc-300">Szczegóły seansu</span>
      </nav>

      {state.status === "loading" ? (
        <StateCard
          icon="spinner"
          title="Wczytujemy seans"
          description="Za chwilę pokażemy plan sali i wolne miejsca."
        />
      ) : null}

      {state.status === "not-found" ? (
        <StateCard
          title="Nie znaleźliśmy tego seansu"
          description="Seans mógł zostać usunięty albo link jest nieprawidłowy. Sprawdź aktualny repertuar."
          action={
            <Link
              href="/#repertuar"
              className="inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-bold text-white brand-gradient focus-ring"
            >
              Wróć do repertuaru
            </Link>
          }
        />
      ) : null}

      {state.status === "error" ? (
        <StateCard
          icon="warning"
          title="Coś poszło nie tak"
          description={state.message}
          action={
            <>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-bold text-white brand-gradient focus-ring"
              >
                Spróbuj ponownie
              </button>
              <Link
                href="/#repertuar"
                className="inline-flex items-center gap-2 rounded-2xl border border-white/15 px-6 py-3 text-sm font-semibold text-white hover:bg-white/5 focus-ring"
              >
                Repertuar
              </Link>
            </>
          }
        />
      ) : null}

      {state.status === "ready" ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-12">
          <div className="space-y-6">
            <EventPoster
              event={state.event}
              className="aspect-4/5 rounded-3xl shadow-2xl shadow-primary/20 ring-1 ring-white/10"
            />

            <div>
              <h1 className="text-3xl font-black leading-tight text-white sm:text-4xl">
                {state.event.title}
              </h1>
              <p className="mt-4 text-sm leading-relaxed text-zinc-400">
                {state.event.description}
              </p>

              <dl className="mt-6 space-y-3 border-t border-white/10 pt-6 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-500">Termin</dt>
                  <dd className="text-right font-semibold text-white">
                    {formatEventWeekday(state.event.startsAt)}
                    <span className="block text-xs font-normal text-zinc-400">
                      {formatEventDate(state.event.startsAt)}
                    </span>
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-500">Sala</dt>
                  <dd className="font-semibold text-white">
                    {state.event.venue}
                  </dd>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <dt className="text-zinc-500">Układ sali</dt>
                  <dd className="font-semibold text-white">
                    {state.event.rows} rzędów × {state.event.seatsPerRow} miejsc
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="surface-card p-5 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-white sm:text-2xl">
                  Wybierz miejsce
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Kliknij wolny fotel. Zajęte miejsca są nieaktywne.
                </p>
              </div>
              <span className="rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-400/20">
                {countFreeSeats(
                  state.event.rows,
                  state.event.seatsPerRow,
                  state.takenSeats,
                )}{" "}
                wolnych
              </span>
            </div>

            <div className="mt-8">
              <SeatMap
                rows={state.event.rows}
                seatsPerRow={state.event.seatsPerRow}
                takenSeats={state.takenSeats}
                selected={selected}
                onSelect={setSelected}
              />
            </div>

            <div className="sticky bottom-4 mt-8 rounded-2xl border border-white/10 bg-ink-soft/95 p-4 backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                    Twoje miejsce
                  </p>
                  <p className="mt-1 text-lg font-bold text-white">
                    {selected ? `Miejsce ${selected}` : "Nie wybrano miejsca"}
                  </p>
                </div>

                {selected ? (
                  <Link
                    href={`/reserve?eventId=${encodeURIComponent(state.event.id)}&seatId=${encodeURIComponent(selected)}`}
                    className="inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-bold text-white transition-transform hover:-translate-y-0.5 focus-ring brand-gradient"
                  >
                    Dalej
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="size-4"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    className="inline-flex cursor-not-allowed items-center gap-2 rounded-2xl bg-white/5 px-6 py-3 text-sm font-bold text-zinc-500"
                  >
                    Dalej
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
