import type { Metadata } from "next";
import { Suspense } from "react";
import { StateCard } from "@/components/state-card";
import { EventDetail } from "./event-detail";

export const metadata: Metadata = {
  title: "Szczegóły seansu — Technikino",
};

async function EventDetailFromParams({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EventDetail eventId={id} />;
}

export default function EventPage({
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
              title="Wczytujemy seans"
              description="Za chwilę pokażemy plan sali i wolne miejsca."
            />
          </div>
        }
      >
        <EventDetailFromParams params={params} />
      </Suspense>
    </div>
  );
}
