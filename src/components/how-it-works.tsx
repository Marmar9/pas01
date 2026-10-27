const steps = [
  {
    number: "01",
    title: "Wybierz seans",
    description:
      "Przejrzyj repertuar i wybierz film oraz godzinę, która pasuje do Twojego planu.",
  },
  {
    number: "02",
    title: "Wskaż miejsce",
    description:
      "Kliknij wolny fotel na interaktywnym planie sali. Zajęte miejsca widzisz od razu.",
  },
  {
    number: "03",
    title: "Odbierz kod",
    description:
      "Podaj imię i e-mail, a my wygenerujemy unikalny kod rezerwacji. Pokaż go przy wejściu.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="jak-to-dziala"
      className="relative isolate overflow-hidden bg-ink py-20 lg:py-28"
    >
      <div
        aria-hidden="true"
        className="glow-blob left-1/3 top-0 size-72 bg-primary/40"
      />

      <div className="container-page">
        <div className="max-w-2xl">
          <p className="text-xs font-bold uppercase tracking-[0.28em] text-secondary">
            Jak to działa
          </p>
          <h2 className="mt-4 text-3xl font-black leading-tight text-white sm:text-4xl lg:text-5xl">
            Trzy kroki do <span className="text-gradient">wolnego fotela</span>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400">
            Cały proces zajmuje mniej niż minutę. Bez rejestracji, bez
            drukowania, bez stania w kolejce.
          </p>
        </div>

        <ol className="mt-12 grid gap-5 md:grid-cols-3">
          {steps.map((step) => (
            <li
              key={step.number}
              className="surface-card group relative p-7 transition-colors hover:border-secondary/40"
            >
              <span className="text-5xl font-black leading-none text-white/10 transition-colors group-hover:text-secondary/40">
                {step.number}
              </span>
              <h3 className="mt-4 text-xl font-bold text-white">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                {step.description}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
