import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { StateCard } from "@/components/state-card";
import { ReserveView } from "./reserve-view";

export const metadata: Metadata = {
  title: "Rezerwacja — Technikino",
};

export default function ReservePage() {
  return (
    <div className="min-h-dvh bg-ink pb-24 pt-28 sm:pt-32">
      <div className="container-page">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-400 transition-colors hover:text-white"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="size-4"
          >
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Repertuar
        </Link>

        <div className="mx-auto mt-8 max-w-2xl">
          <p className="eyebrow text-secondary">Ostatni krok</p>
          <h1 className="display-title mt-3 text-4xl text-white sm:text-5xl">
            Zarezerwuj fotel
          </h1>
          <p className="mt-4 text-sm text-zinc-400">
            Podaj dane, a my przypiszemy miejsce do Twojej rezerwacji i
            wygenerujemy kod odbioru.
          </p>

          <div className="mt-10">
            <Suspense
              fallback={
                <StateCard
                  icon="spinner"
                  title="Przygotowujemy formularz"
                  description="Sprawdzamy szczegóły seansu i dostępność fotela."
                />
              }
            >
              <ReserveView />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
