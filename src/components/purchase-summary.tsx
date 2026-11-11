import { formatPrice } from "@/lib/format";
import { cardAmountFor, formatPoints } from "@/lib/loyalty-points";

export type PurchaseSummaryData = {
  amount: number;
  pointsUsed: number;
  pointsEarned?: number;
};

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink px-6 py-5">
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        {label}
      </p>
      <p className="mt-2 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

export function PurchaseSummary({
  amount,
  pointsUsed,
  pointsEarned,
}: PurchaseSummaryData) {
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="grid gap-px bg-white/10 sm:grid-cols-3">
        <SummaryCell
          label="Zapłacono kartą"
          value={formatPrice(cardAmountFor(amount, pointsUsed))}
        />
        <SummaryCell
          label="Wykorzystane punkty"
          value={`${formatPoints(pointsUsed)} (${formatPrice(pointsUsed)})`}
        />
        <SummaryCell
          label="Zdobyte punkty"
          value={pointsEarned === undefined ? "—" : formatPoints(pointsEarned)}
        />
      </div>
    </div>
  );
}
