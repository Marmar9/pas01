import type { EventDto } from "@/lib/client-api";
import { eventTheme } from "@/lib/event-theme";

type EventPosterProps = {
  event: EventDto;
  className?: string;
  compact?: boolean;
};

export function EventPoster({
  event,
  className,
  compact = false,
}: EventPosterProps) {
  const theme = eventTheme(event.id);

  return (
    <div
      className={`relative isolate overflow-hidden ${className ?? ""}`}
      style={{
        backgroundImage: `linear-gradient(150deg, ${theme.from} 0%, ${theme.to} 100%)`,
      }}
      aria-hidden="true"
    >
      <div className="absolute inset-0 poster-grain opacity-70" />
      <div
        className="absolute -right-10 -top-10 size-40 rounded-full opacity-40 blur-2xl"
        style={{ backgroundColor: theme.accent }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(11,7,19,0.05)_0%,rgba(11,7,19,0.15)_45%,rgba(11,7,19,0.75)_100%)]" />

      <div
        className={`relative flex h-full flex-col justify-between ${compact ? "p-4" : "p-5"}`}
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.35em] text-white/70">
          Technikino
        </span>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-white/60">
            {theme.label}
          </p>
          <p
            className={`mt-2 line-clamp-3 font-black uppercase leading-[0.95] text-white ${
              compact ? "text-lg" : "text-2xl"
            }`}
          >
            {event.title}
          </p>
        </div>
      </div>
    </div>
  );
}
