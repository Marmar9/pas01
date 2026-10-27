import { EventGrid } from "@/components/event-grid";
import { FeatureBand } from "@/components/feature-band";
import { Hero } from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";

export default function HomePage() {
  return (
    <>
      <Hero />

      <section id="repertuar" className="bg-[#f5f3fa] py-20 lg:py-28">
        <div className="container-page">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.28em] text-secondary">
                Repertuar
              </p>
              <h2 className="mt-4 text-3xl font-black leading-tight text-ink sm:text-4xl lg:text-5xl">
                Wybierz swój <span className="text-primary">seans</span>
              </h2>
              <p className="mt-4 text-base leading-relaxed text-zinc-600">
                Trzy sale, starannie dobrane filmy i miejsca, które naprawdę na
                Ciebie czekają.
              </p>
            </div>

            <span className="inline-flex items-center gap-2 self-start rounded-full bg-white px-4 py-2 text-xs font-semibold text-zinc-600 shadow-sm ring-1 ring-ink/5 sm:self-auto">
              <span
                className="size-1.5 animate-pulse-dot rounded-full bg-emerald-500"
                aria-hidden="true"
              />
              Rezerwacje otwarte
            </span>
          </div>

          <div className="mt-12">
            <EventGrid />
          </div>
        </div>
      </section>

      <HowItWorks />
      <FeatureBand />
    </>
  );
}
