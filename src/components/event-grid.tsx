"use client";

import { useCallback, useEffect, useState } from "react";
import { EventCard } from "@/components/event-card";
import { type EventDto, getEvent, getEvents } from "@/lib/client-api";
import { countFreeSeats } from "@/lib/seats";

type GridState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; events: EventDto[]; freeSeats: Record<string, number> };

export function EventGrid() {
  const [state, setState] = useState<GridState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });

    try {
      const events = await getEvents();
      const details = await Promise.allSettled(
        events.map((event) => getEvent(event.id)),
      );
      const freeSeats: Record<string, number> = {};

      details.forEach((detail, index) => {
        if (detail.status === "fulfilled") {
          const event = events[index];
          freeSeats[event.id] = countFreeSeats(
            event.rows,
            event.seatsPerRow,
            detail.value.takenSeats,
          );
        }
      });

      setState({ status: "ready", events, freeSeats });
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Nie udało się pobrać repertuaru.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <div
        className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">Wczytujemy repertuar…</span>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="animate-pulse overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-ink/5"
          >
            <div className="aspect-4/3 bg-zinc-200" />
            <div className="space-y-3 p-6">
              <div className="h-3 w-24 rounded-full bg-zinc-200" />
              <div className="h-5 w-3/4 rounded-full bg-zinc-200" />
              <div className="h-3 w-full rounded-full bg-zinc-100" />
              <div className="h-3 w-2/3 rounded-full bg-zinc-100" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="rounded-3xl border border-secondary/30 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-bold text-ink">
          Nie udało się wczytać repertuaru
        </p>
        <p className="mx-auto mt-2 max-w-md text-sm text-zinc-600">
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-6 inline-flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-bold text-white transition-transform hover:-translate-y-0.5 focus-ring brand-gradient"
        >
          Spróbuj ponownie
        </button>
      </div>
    );
  }

  if (state.events.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-ink/15 bg-white/60 p-10 text-center">
        <p className="text-lg font-bold text-ink">Brak seansów w repertuarze</p>
        <p className="mt-2 text-sm text-zinc-600">
          Zajrzyj do nas wkrótce — dodajemy nowe pokazy.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {state.events.map((event) => (
        <EventCard
          key={event.id}
          event={event}
          freeSeats={state.freeSeats[event.id]}
        />
      ))}
    </div>
  );
}
