import Link from "next/link";

const features = [
  {
    title: "Bezpieczna rezerwacja",
    description:
      "Każde żądanie ma unikalny klucz idempotencji — nie zarezerwujesz dwóch miejsc przez pomyłkę.",
    icon: (
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3zM9 12l2 2 4-4" />
    ),
  },
  {
    title: "Natychmiastowy kod",
    description:
      "Kod rezerwacji dostajesz od razu po potwierdzeniu. Zapisz go lub pokaż na telefonie.",
    icon: <path d="M4 6h16v12H4zM8 10h4M8 14h8" />,
  },
  {
    title: "Zero kolejek",
    description:
      "Miejsce czeka na Ciebie do seansu. Przychodzisz, pokazujesz kod i wchodzisz.",
    icon: <path d="M4 18l4-4 3 3 5-6 4 4M4 6h6M4 10h3" />,
  },
];

export function FeatureBand() {
  return (
    <section id="dlaczego-my" className="bg-ink pb-20 lg:pb-28">
      <div className="container-page">
        <div className="relative isolate overflow-hidden rounded-3xl px-6 py-12 sm:px-10 lg:px-14 lg:py-16 brand-gradient">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.25),transparent_55%)]"
          />
          <div
            aria-hidden="true"
            className="absolute -bottom-24 -right-16 size-72 rounded-full border border-white/15"
          />

          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-white/70">
              Dlaczego Technikino
            </p>
            <h2 className="mt-4 max-w-2xl text-3xl font-black leading-tight text-white sm:text-4xl">
              Kino, które szanuje Twój czas
            </h2>

            <ul className="mt-10 grid gap-6 md:grid-cols-3">
              {features.map((feature) => (
                <li key={feature.title}>
                  <span className="grid size-11 place-items-center rounded-2xl bg-white/15 text-white backdrop-blur">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="size-5"
                    >
                      {feature.icon}
                    </svg>
                  </span>
                  <h3 className="mt-4 text-lg font-bold text-white">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/80">
                    {feature.description}
                  </p>
                </li>
              ))}
            </ul>

            <Link
              href="#repertuar"
              className="mt-10 inline-flex items-center gap-2 rounded-2xl bg-ink px-6 py-3.5 text-sm font-bold text-white transition-transform hover:-translate-y-0.5 focus-ring"
            >
              Przejdź do repertuaru
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
          </div>
        </div>
      </div>
    </section>
  );
}
