"use client";

import { buildSeatRows } from "@/lib/seats";

type SeatMapProps = {
  rows: number;
  seatsPerRow: number;
  takenSeats: string[];
  selected: string | null;
  onSelect: (seatId: string | null) => void;
};

export function SeatMap({
  rows,
  seatsPerRow,
  takenSeats,
  selected,
  onSelect,
}: SeatMapProps) {
  const taken = new Set(takenSeats);
  const seatRows = buildSeatRows(rows, seatsPerRow);

  return (
    <div className="w-full">
      <div className="mb-2 text-center text-[10px] font-bold uppercase tracking-[0.4em] text-zinc-500">
        Ekran
      </div>
      <div className="mx-auto mb-10 h-2 w-4/5 rounded-full bg-linear-to-r from-primary/10 via-white/70 to-secondary/20 shadow-[0_0_30px_rgba(255,255,255,0.25)]" />

      <div className="overflow-x-auto pb-4">
        <fieldset className="mx-auto flex w-max min-w-full flex-col items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">Plan sali kinowej</legend>
          {seatRows.map((seats, rowIndex) => (
            <div key={seats[0]} className="flex items-center gap-1.5">
              <span
                className="w-4 text-right text-[11px] font-semibold text-zinc-500"
                aria-hidden="true"
              >
                {String.fromCharCode(65 + rowIndex)}
              </span>

              {seats.map((seatId) => {
                const isTaken = taken.has(seatId);
                const isSelected = selected === seatId;

                return (
                  <button
                    key={seatId}
                    type="button"
                    disabled={isTaken}
                    aria-pressed={isSelected}
                    aria-label={
                      isTaken
                        ? `Miejsce ${seatId}, zajęte`
                        : `Miejsce ${seatId}`
                    }
                    title={
                      isTaken
                        ? `Miejsce ${seatId} — zajęte`
                        : `Miejsce ${seatId}`
                    }
                    onClick={() => onSelect(isSelected ? null : seatId)}
                    className={[
                      "grid size-7 place-items-center rounded-t-md text-[10px] font-semibold transition-all duration-150 sm:size-8 focus-ring",
                      isTaken
                        ? "cursor-not-allowed bg-zinc-800 text-zinc-600"
                        : isSelected
                          ? "scale-105 text-white ring-2 ring-white/80 brand-gradient"
                          : "bg-white/10 text-zinc-300 hover:-translate-y-0.5 hover:bg-primary hover:text-white",
                    ].join(" ")}
                  >
                    {seatId.slice(1)}
                  </button>
                );
              })}

              <span
                className="w-4 text-[11px] font-semibold text-zinc-500"
                aria-hidden="true"
              >
                {String.fromCharCode(65 + rowIndex)}
              </span>
            </div>
          ))}
        </fieldset>
      </div>

      <ul className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-zinc-400">
        <li className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 rounded-t-sm bg-white/10 ring-1 ring-white/20"
          />
          Wolne
        </li>
        <li className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 rounded-t-sm bg-zinc-800"
          />
          Zajęte
        </li>
        <li className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 rounded-t-sm brand-gradient ring-1 ring-white/40"
          />
          Wybrane
        </li>
      </ul>
    </div>
  );
}
