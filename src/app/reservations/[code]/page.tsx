import type { Metadata } from "next";
import { Suspense } from "react";
import { StateCard } from "@/components/state-card";
import { Confirmation } from "./confirmation";

export const metadata: Metadata = {
  title: "Rezerwacja potwierdzona — Technikino",
};

type ConfirmationParams = {
  code: string;
  eventId?: string;
  seatId?: string;
};

async function ConfirmationFromParams({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ code }, query] = await Promise.all([params, searchParams]);
  const eventId = typeof query.eventId === "string" ? query.eventId : undefined;
  const seatId = typeof query.seatId === "string" ? query.seatId : undefined;
  const props: ConfirmationParams = { code, eventId, seatId };

  return <Confirmation {...props} />;
}

export default function ReservationPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <div className="min-h-dvh bg-ink">
      <Suspense
        fallback={
          <div className="container-page pb-24 pt-32">
            <StateCard
              icon="spinner"
              title="Wczytujemy rezerwację"
              description="Za chwilę pokażemy Twój kod."
            />
          </div>
        }
      >
        <ConfirmationFromParams params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
