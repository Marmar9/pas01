import type { Metadata } from "next";
import { Suspense } from "react";
import { StateCard } from "@/components/state-card";
import { PaymentCancel } from "./payment-cancel";

export const metadata: Metadata = {
  title: "Płatność przerwana — Technikino",
};

async function PaymentCancelFromParams({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PaymentCancel reservationId={id} />;
}

export default function PaymentCancelPage({
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
              title="Sprawdzamy rezerwację"
              description="Za chwilę pokażemy status płatności."
            />
          </div>
        }
      >
        <PaymentCancelFromParams params={params} />
      </Suspense>
    </div>
  );
}
