import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { StateCard } from "@/components/state-card";
import { getDb } from "@/db/client";
import { getPaidTicketByCode } from "@/lib/reservations";
import { Confirmation } from "./confirmation";

export const metadata: Metadata = {
  title: "Bilet — Technikino",
};

// URL: /reservations/:code. Next.js requires one slug name per dynamic level,
// and /reservations/:id/payment/* already uses [id], so the ticket code
// arrives as params.id.
async function TicketFromParams({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();

  const { id: code } = await params;
  const ticket = getPaidTicketByCode(getDb(), code);

  if (!ticket) {
    return (
      <div className="container-page pb-24 pt-28 sm:pt-32">
        <StateCard
          icon="warning"
          title="Nie znaleźliśmy biletu"
          description="Ten kod nie należy do opłaconej rezerwacji. Bilet pojawi się dopiero po potwierdzeniu płatności."
          action={
            <Link href="/" className="btn-primary">
              Wróć do repertuaru
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <Confirmation
      code={ticket.code}
      eventId={ticket.eventId}
      seatId={ticket.seatId}
    />
  );
}

export default function ReservationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="min-h-dvh bg-ink">
      <Suspense
        fallback={
          <div className="container-page pb-24 pt-32">
            <StateCard
              icon="spinner"
              title="Wczytujemy bilet"
              description="Sprawdzamy, czy rezerwacja jest opłacona."
            />
          </div>
        }
      >
        <TicketFromParams params={params} />
      </Suspense>
    </div>
  );
}
