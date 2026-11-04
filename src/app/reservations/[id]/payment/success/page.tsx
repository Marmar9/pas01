import type { Metadata } from "next";
import { Suspense } from "react";
import { StateCard } from "@/components/state-card";
import { PaymentSuccess } from "./payment-success";

export const metadata: Metadata = {
  title: "Płatność w toku — Technikino",
};

async function PaymentSuccessFromParams({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PaymentSuccess reservationId={id} />;
}

export default function PaymentSuccessPage({
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
              title="Sprawdzamy płatność"
              description="Za chwilę pokażemy Twój bilet."
            />
          </div>
        }
      >
        <PaymentSuccessFromParams params={params} />
      </Suspense>
    </div>
  );
}
