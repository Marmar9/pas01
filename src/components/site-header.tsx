"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Wordmark } from "@/components/wordmark";

const navLinks = [
  { href: "/#repertuar", label: "Repertuar" },
  { href: "/#jak-to-dziala", label: "Jak to działa" },
  { href: "/#dlaczego-my", label: "Dlaczego my" },
];

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const shell =
    scrolled || open
      ? "border-white/10 bg-ink/85 backdrop-blur-xl"
      : "border-transparent bg-transparent";

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-300 ${shell}`}
    >
      <div className="container-page flex h-16 items-center justify-between gap-6 sm:h-20">
        <Wordmark />

        <nav
          aria-label="Nawigacja główna"
          className="hidden items-center gap-8 md:flex"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-zinc-300 transition-colors hover:text-white focus-ring rounded-md"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link
            href="/#repertuar"
            className="hidden items-center gap-2 rounded-2xl px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-secondary/25 transition-transform hover:-translate-y-0.5 focus-ring brand-gradient sm:inline-flex"
          >
            Zarezerwuj
            <ArrowIcon />
          </Link>

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Zamknij menu" : "Otwórz menu"}
            className="grid size-10 place-items-center rounded-xl border border-white/15 text-white transition-colors hover:bg-white/10 focus-ring md:hidden"
          >
            {open ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="size-5"
              >
                <title>Zamknij menu</title>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="size-5"
              >
                <title>Otwórz menu</title>
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <div
        id="mobile-menu"
        hidden={!open}
        className="border-t border-white/10 bg-ink/95 backdrop-blur-xl md:hidden"
      >
        <nav
          aria-label="Nawigacja mobilna"
          className="container-page flex flex-col gap-1 py-4"
        >
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="rounded-xl px-3 py-3 text-base font-medium text-zinc-200 transition-colors hover:bg-white/5 hover:text-white focus-ring"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/#repertuar"
            onClick={() => setOpen(false)}
            className="mt-2 inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold text-white brand-gradient"
          >
            Zarezerwuj miejsce
            <ArrowIcon />
          </Link>
        </nav>
      </div>
    </header>
  );
}

function ArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4"
    >
      <title>Przejdź</title>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
