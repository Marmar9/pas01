"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type EventDto, getEvent } from "@/lib/client-api";
import { eventTheme } from "@/lib/event-theme";
import { formatEventDate } from "@/lib/format";

type ConfirmationProps = {
  code: string;
  eventId?: string;
  seatId?: string;
};

type EventState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "success"; event: EventDto };

export function Confirmation({ code, eventId, seatId }: ConfirmationProps) {
  const [eventState, setEventState] = useState<EventState>(
    eventId ? { status: "loading" } : { status: "idle" },
  );
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!eventId) {
      return;
    }

    const controller = new AbortController();

    getEvent(eventId)
      .then((result) =>
        setEventState({ status: "success", event: result.event }),
      )
      .catch(() => {
        if (!controller.signal.aborted) {
          setEventState({ status: "error" });
        }
      });

    return () => controller.abort();
  }, [eventId]);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const theme = eventTheme(eventId ?? code);
  const event = eventState.status === "success" ? eventState.event : null;

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="container-page pb-24 pt-28 sm:pt-32">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-300">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-secondary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-secondary" />
            </span>
            Gotowe
          </span>
          <h1 className="mt-6 font-display text-4xl font-black uppercase leading-[0.95] tracking-tight text-white sm:text-6xl">
            Rezerwacja
            <br />
            <span className="text-gradient">potwierdzona</span>
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-zinc-400">
            Miejsce jest zablokowane. Zapisz kod i pokaż go przy wejściu do
            sali.
          </p>
        </div>

        <div className="mt-10 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.03] shadow-glow">
          <div
            className="relative overflow-hidden px-6 py-8 sm:px-10"
            style={{
              backgroundImage: `linear-gradient(135deg, ${theme.from}, ${theme.to})`,
            }}
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_80%_0%,rgba(255,255,255,0.35),transparent_60%)]" />
            <p className="relative text-[11px] font-semibold uppercase tracking-[0.28em] text-white/70">
              Kod rezerwacji
            </p>
            <div className="relative mt-3 flex flex-wrap items-center gap-4">
              <p className="font-mono text-3xl font-bold tracking-[0.2em] text-white sm:text-5xl">
                {code}
              </p>
              <button
                type="button"
                onClick={copyCode}
                className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-4 py-2 text-xs font-semibold text-white backdrop-blur transition hover:bg-white/20 focus-ring"
              >
                {copied ? "Skopiowano" : "Kopiuj"}
              </button>
            </div>
            {copyFailed ? (
              <p className="relative mt-3 text-xs text-white/80">
                Nie udało się skopiować automatycznie — zaznacz kod ręcznie.
              </p>
            ) : null}
          </div>

          <div className="grid gap-px bg-white/10 sm:grid-cols-3">
            <div className="bg-ink px-6 py-5">
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                Film
              </p>
              <p className="mt-2 text-sm font-semibold text-white">
                {eventState.status === "loading"
                  ? "Wczytujemy…"
                  : event
                    ? event.title
                    : "Szczegóły w repertuarze"}
              </p>
            </div>
            <div className="bg-ink px-6 py-5">
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                Seans
              </p>
              <p className="mt-2 text-sm font-semibold text-white">
                {event ? formatEventDate(event.startsAt) : "—"}
              </p>
            </div>
            <div className="bg-ink px-6 py-5">
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                Miejsce
              </p>
              <p className="mt-2 text-sm font-semibold text-white">
                {seatId ?? "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/" className="btn-primary justify-center">
            Wróć do repertuaru
            <span aria-hidden="true">→</span>
          </Link>
          {eventId ? (
            <Link
              href={`/events/${eventId}`}
              className="btn-ghost justify-center"
            >
              Zobacz plan sali
            </Link>
          ) : null}
        </div>

        <p className="mt-8 text-center text-xs text-zinc-500">
          Rezerwacja jest ważna do rozpoczęcia seansu. Zmiany i anulowanie —
          przy kasie.
        </p>
      </div>
    </div>
  );
}
