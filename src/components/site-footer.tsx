import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-ink">
      <div className="container-page py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div className="space-y-4">
            <Wordmark />
            <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
              Technikino to kino przyszłości — rezerwujesz miejsce online w
              kilka sekund, a przy wejściu pokazujesz tylko kod. Bez kolejek,
              bez papierowych biletów.
            </p>
          </div>

          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">
              Kino
            </h2>
            <ul className="mt-4 space-y-3 text-sm text-zinc-300">
              <li>
                <Link
                  href="/#repertuar"
                  className="transition-colors hover:text-white focus-ring rounded-md"
                >
                  Repertuar
                </Link>
              </li>
              <li>
                <Link
                  href="/#jak-to-dziala"
                  className="transition-colors hover:text-white focus-ring rounded-md"
                >
                  Jak to działa
                </Link>
              </li>
              <li>
                <Link
                  href="/#dlaczego-my"
                  className="transition-colors hover:text-white focus-ring rounded-md"
                >
                  Dlaczego my
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">
              Kontakt
            </h2>
            <ul className="mt-4 space-y-3 text-sm text-zinc-300">
              <li>ul. Kinowa 12, 00-001 Warszawa</li>
              <li>
                <a
                  href="mailto:kontakt@technikino.pl"
                  className="transition-colors hover:text-white focus-ring rounded-md"
                >
                  kontakt@technikino.pl
                </a>
              </li>
              <li className="text-zinc-400">Codziennie 10:00–23:00</li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Technikino. Wszelkie prawa zastrzeżone.</p>
          <p>Inspirowane Technischools · Projekt demonstracyjny</p>
        </div>
      </div>
    </footer>
  );
}
