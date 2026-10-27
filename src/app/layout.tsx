import type { Metadata } from "next";
import { Roboto } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const roboto = Roboto({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "700", "900"],
  variable: "--font-roboto",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Technikino — kino przyszłości",
  description:
    "Zarezerwuj miejsce w Technikino w kilka sekund. Wybierz seans, wskaż miejsce i odbierz kod — bez kolejek i papierowych biletów.",
  applicationName: "Technikino",
  openGraph: {
    title: "Technikino — kino przyszłości",
    description:
      "Rezerwacja miejsc online w kilka sekund. Bez kolejek, bez papierowych biletów.",
    locale: "pl_PL",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl" className={roboto.variable}>
      <body className="min-h-dvh bg-ink font-sans text-zinc-100 antialiased">
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
