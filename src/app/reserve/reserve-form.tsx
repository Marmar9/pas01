"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, createReservation, type EventDto } from "@/lib/client-api";
import { formatEventDate } from "@/lib/format";

type ReserveFormProps = {
  event: EventDto;
  seatId: string;
};

type FieldErrors = { customerName?: string; email?: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ReserveForm({ event, seatId }: ReserveFormProps) {
  const router = useRouter();
  const idempotencyKey = useRef<string>("");
  const [customerName, setCustomerName] = useState("");
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [seatTaken, setSeatTaken] = useState(false);
  const [pending, setPending] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    idempotencyKey.current = crypto.randomUUID();
  }, []);

  useEffect(() => {
    if (lockedUntil === 0) {
      return;
    }

    const tick = () => {
      const remaining = Math.max(
        0,
        Math.ceil((lockedUntil - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setLockedUntil(0);
        setFormError(null);
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const locked = lockedUntil > Date.now();
  const disabled = pending || locked;

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const trimmedName = customerName.trim();

    if (trimmedName.length < 2) {
      errors.customerName = "Podaj imię i nazwisko (min. 2 znaki).";
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      errors.email = "Podaj poprawny adres e-mail.";
    }

    return errors;
  }

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (disabled) {
      return;
    }

    setFormError(null);
    setSeatTaken(false);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setPending(true);
    try {
      if (!idempotencyKey.current) {
        idempotencyKey.current = crypto.randomUUID();
      }

      const result = await createReservation(
        {
          eventId: event.id,
          seatId,
          customerName: customerName.trim(),
          email: email.trim(),
        },
        idempotencyKey.current,
      );

      router.push(
        `/reservations/${encodeURIComponent(result.code)}?eventId=${encodeURIComponent(
          event.id,
        )}&seatId=${encodeURIComponent(seatId)}`,
      );
    } catch (error) {
      handleError(error);
    } finally {
      setPending(false);
    }
  }

  function handleError(error: unknown) {
    if (!(error instanceof ApiError)) {
      setFormError("Coś poszło nie tak. Spróbuj ponownie za chwilę.");
      return;
    }

    switch (error.code) {
      case "VALIDATION_ERROR": {
        const details = error.details ?? {};
        setFieldErrors({
          customerName: details.customerName,
          email: details.email,
        });
        setFormError(
          Object.keys(details).length === 0
            ? "Sprawdź poprawność danych w formularzu."
            : null,
        );
        break;
      }
      case "SEAT_TAKEN":
        setSeatTaken(true);
        setFormError("To miejsce właśnie zostało zarezerwowane.");
        break;
      case "RATE_LIMITED": {
        const retryAfter = Math.max(1, Math.ceil(error.retryAfter ?? 30));
        setLockedUntil(Date.now() + retryAfter * 1000);
        setFormError(
          `Zbyt wiele rezerwacji. Spróbuj ponownie za ${retryAfter} s.`,
        );
        break;
      }
      case "IDEMPOTENCY_KEY_REUSED":
        idempotencyKey.current = crypto.randomUUID();
        setFormError("Odświeżyliśmy sesję rezerwacji. Spróbuj jeszcze raz.");
        break;
      case "EVENT_NOT_FOUND":
        setFormError("Ten seans nie jest już dostępny.");
        break;
      case "NETWORK_ERROR":
        setFormError(
          "Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.",
        );
        break;
      default:
        setFormError("Nie udało się zarezerwować miejsca. Spróbuj ponownie.");
    }
  }

  const inputClass =
    "mt-2 w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-3 text-sm text-white placeholder:text-zinc-600 transition-colors focus:border-secondary/60 focus:outline-none";

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      <div className="surface-card p-6 sm:p-8">
        <p className="eyebrow text-secondary">Twoja rezerwacja</p>
        <h2 className="mt-3 text-2xl font-black text-white">{event.title}</h2>
        <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              Termin
            </dt>
            <dd className="mt-1 font-semibold text-white">
              {formatEventDate(event.startsAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              Miejsce
            </dt>
            <dd className="mt-1 font-semibold text-white">{event.venue}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              Fotel
            </dt>
            <dd className="mt-1 font-semibold text-secondary">{seatId}</dd>
          </div>
        </dl>
      </div>

      <div className="surface-card space-y-5 p-6 sm:p-8">
        <div>
          <label
            htmlFor="customerName"
            className="text-sm font-semibold text-white"
          >
            Imię i nazwisko
          </label>
          <input
            id="customerName"
            name="customerName"
            type="text"
            autoComplete="name"
            value={customerName}
            onChange={(changeEvent) => {
              setCustomerName(changeEvent.target.value);
              setFieldErrors((current) => ({
                ...current,
                customerName: undefined,
              }));
            }}
            aria-invalid={fieldErrors.customerName ? true : undefined}
            aria-describedby={
              fieldErrors.customerName ? "customerName-error" : undefined
            }
            placeholder="np. Anna Kowalska"
            className={inputClass}
          />
          {fieldErrors.customerName ? (
            <p id="customerName-error" className="mt-2 text-xs text-red-400">
              {fieldErrors.customerName}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="email" className="text-sm font-semibold text-white">
            Adres e-mail
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(changeEvent) => {
              setEmail(changeEvent.target.value);
              setFieldErrors((current) => ({
                ...current,
                email: undefined,
              }));
            }}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
            placeholder="np. anna@example.com"
            className={inputClass}
          />
          {fieldErrors.email ? (
            <p id="email-error" className="mt-2 text-xs text-red-400">
              {fieldErrors.email}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-zinc-500">
            Kod rezerwacji wyślemy na ten adres.
          </p>
        </div>

        {formError ? (
          <div
            role="alert"
            className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
          >
            <p>{formError}</p>
            {seatTaken ? (
              <a
                href={`/events/${event.id}`}
                className="mt-2 inline-flex font-semibold text-white underline underline-offset-4"
              >
                Wybierz inne miejsce
              </a>
            ) : null}
            {locked ? (
              <p className="mt-2 text-xs text-red-300/80">
                Odblokowanie za {secondsLeft} s.
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={disabled}
          className="btn-cta w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            "Rezerwujemy…"
          ) : locked ? (
            `Poczekaj ${secondsLeft} s`
          ) : (
            <>
              Potwierdź rezerwację
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="size-4"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </>
          )}
        </button>

        <p className="text-center text-xs text-zinc-500">
          Rezerwując, akceptujesz regulamin Technikino.
        </p>
      </div>
    </form>
  );
}
