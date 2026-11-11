// 1 point = 1 grosz; at most half of the ticket may be paid with points.
export function maxSpendablePoints(amount: number, balance: number): number {
  if (
    !Number.isFinite(amount) ||
    !Number.isFinite(balance) ||
    amount <= 0 ||
    balance <= 0
  ) {
    return 0;
  }

  return Math.min(Math.floor(amount / 2), Math.floor(balance));
}

export function clampPoints(raw: number, max: number): number {
  if (!Number.isFinite(raw) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }

  return Math.min(Math.max(0, Math.floor(raw)), Math.floor(max));
}

export function cardAmountFor(amount: number, points: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(points) || amount <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(amount) - Math.max(0, Math.floor(points)));
}

export function formatPoints(points: number): string {
  return `${clampPoints(points, Number.MAX_SAFE_INTEGER)} pkt`;
}
