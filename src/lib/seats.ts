const SEAT_ID_PATTERN = /^[A-Z]([1-9][0-9]?)$/;

export function rowLabel(rowIndex: number): string {
  return String.fromCharCode(65 + rowIndex);
}

export function toSeatId(rowIndex: number, seatNumber: number): string {
  return `${rowLabel(rowIndex)}${seatNumber}`;
}

export function isValidSeatId(value: string): boolean {
  return SEAT_ID_PATTERN.test(value);
}

export function normalizeSeatId(value: string): string {
  return value.trim().toUpperCase();
}

export function buildSeatRows(rows: number, seatsPerRow: number): string[][] {
  return Array.from({ length: Math.max(0, rows) }, (_, rowIndex) =>
    Array.from({ length: Math.max(0, seatsPerRow) }, (_, seatIndex) =>
      toSeatId(rowIndex, seatIndex + 1),
    ),
  );
}

export function countFreeSeats(
  rows: number,
  seatsPerRow: number,
  takenSeats: string[],
): number {
  const total = Math.max(0, rows) * Math.max(0, seatsPerRow);
  const taken = new Set(takenSeats.map(normalizeSeatId));
  return Math.max(0, total - taken.size);
}
