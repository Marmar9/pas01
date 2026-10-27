import Link from "next/link";
import { EventPoster } from "@/components/event-poster";
import type { EventDto } from "@/lib/client-api";
import { formatEventDateShort } from "@/lib/format";

type EventCardProps = {
  event: EventDto;
  freeSeats?: number;
};

export function EventCard({ event, freeSeats }: EventCardProps) {
  return (
    <Link
      href={`/events/${event.id}`}
      className="group flex flex-col overflow-hidden rounded-3xl bg-white shadow-[0_18px_45px_-30px_rgba(11,7,19,0.6)] ring-1 ring-ink/5 transition duration-300 hover:-translate-y-1.5 hover:shadow-[0_28px_60px_-28px_rgba(56,19,194,0.45)] focus-ring"
    >
      <div className="relative">
        <EventPoster event={event} className="aspect-4/3" />
        <span className="absolute left-4 top-4 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-ink shadow-sm backdrop-blur">
          {formatEventDateShort(event.startsAt)}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-5 sm:p-6">
        <div className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary">
            {event.venue}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {event.rows} × {event.seatsPerRow} miejsc
          </span>
        </div>

        <h3 className="text-xl font-black leading-tight text-ink transition-colors group-hover:text-primary">
          {event.title}
        </h3>

        <p className="line-clamp-2 text-sm leading-relaxed text-zinc-600">
          {event.description}
        </p>

        <div className="mt-auto flex items-center justify-between gap-3 pt-2">
          <span className="text-xs font-semibold text-zinc-500">
            {typeof freeSeats === "number" ? (
              <>
                <span className="text-ink">{freeSeats}</span> wolnych miejsc
              </>
            ) : (
              "Sprawdź dostępność"
            )}
          </span>

          <span className="inline-flex items-center gap-1.5 text-sm font-bold text-primary">
            Wybierz miejsce
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-4 transition-transform duration-300 group-hover:translate-x-1"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
        </div>
      </div>
    </Link>
  );
}
