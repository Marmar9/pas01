const WARSAW = "Europe/Warsaw";

const dateFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: WARSAW,
});

const shortDateFormatter = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: WARSAW,
});

const timeFormatter = new Intl.DateTimeFormat("pl-PL", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: WARSAW,
});

const weekdayFormatter = new Intl.DateTimeFormat("pl-PL", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: WARSAW,
});

function parseDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatEventDate(iso: string): string {
  const date = parseDate(iso);
  return date ? dateFormatter.format(date) : "Termin wkrótce";
}

export function formatEventDateShort(iso: string): string {
  const date = parseDate(iso);
  return date ? shortDateFormatter.format(date) : "Termin wkrótce";
}

export function formatEventTime(iso: string): string {
  const date = parseDate(iso);
  return date ? timeFormatter.format(date) : "--:--";
}

export function formatEventWeekday(iso: string): string {
  const date = parseDate(iso);
  return date ? weekdayFormatter.format(date) : "Termin wkrótce";
}

export function formatRetryAfter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "spróbuj ponownie za chwilę";
  }

  const clamped = Math.min(3600, Math.max(1, Math.ceil(seconds)));
  return `spróbuj ponownie za ${clamped} s`;
}
