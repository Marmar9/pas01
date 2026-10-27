import Link from "next/link";

const stats = [
  { value: "3", label: "seanse w repertuarze" },
  { value: "3", label: "komfortowe sale" },
  { value: "100%", label: "rezerwacji online" },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-ink pb-20 pt-32 sm:pt-36 lg:pb-28 lg:pt-44">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(56,19,194,0.55),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(229,15,136,0.35),transparent_50%)]"
      />
      <div
        aria-hidden="true"
        className="glow-blob -left-24 top-10 size-72 bg-primary/60"
      />
      <div
        aria-hidden="true"
        className="glow-blob -right-16 top-40 size-80 bg-secondary/50"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-linear-to-b from-transparent to-ink"
      />

      <div className="container-page">
        <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
          <span className="inline-flex animate-rise items-center gap-2.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-white/85 backdrop-blur">
            <span
              className="size-2 animate-pulse-dot rounded-full bg-secondary"
              aria-hidden="true"
            />
            Kino przyszłości
          </span>

          <h1 className="mt-7 animate-rise text-[clamp(3.25rem,12vw,10rem)] font-black uppercase leading-[0.85] tracking-[-0.03em] text-white">
            Techni<span className="text-gradient">kino</span>
          </h1>

          <p className="mt-7 max-w-2xl animate-rise text-balance text-base leading-relaxed text-zinc-300 sm:text-lg">
            Zarezerwuj miejsce w kilka sekund — bez kolejek i papierowych
            biletów. Wybierz seans, wskaż fotel i odbierz kod, który pokażesz
            przy wejściu.
          </p>

          <div className="mt-9 flex animate-rise flex-col items-center gap-3 sm:flex-row">
            <Link
              href="#repertuar"
              className="group inline-flex items-center gap-2.5 rounded-2xl px-7 py-4 text-sm font-bold text-white shadow-xl shadow-secondary/30 transition-transform hover:-translate-y-0.5 focus-ring brand-gradient"
            >
              Zarezerwuj miejsce
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
            </Link>
            <Link
              href="#jak-to-dziala"
              className="inline-flex items-center gap-2 rounded-2xl border border-white/20 bg-white/5 px-7 py-4 text-sm font-semibold text-white backdrop-blur transition-colors hover:bg-white/10 focus-ring"
            >
              Zobacz repertuar
            </Link>
          </div>

          <p className="mt-6 inline-flex items-center gap-2 text-xs font-medium text-zinc-400">
            <span
              className="size-1.5 animate-pulse-dot rounded-full bg-secondary"
              aria-hidden="true"
            />
            Rezerwacja online w 3 krokach
          </p>
        </div>

        <dl className="mx-auto mt-16 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="surface-card px-6 py-5 text-center"
            >
              <dt className="sr-only">{stat.label}</dt>
              <dd>
                <span className="block text-3xl font-black text-white">
                  {stat.value}
                </span>
                <span className="mt-1 block text-xs uppercase tracking-[0.18em] text-zinc-400">
                  {stat.label}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
