"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  createReservation,
  type EventDto,
  getLoyalty,
  getReservation,
  startCheckout,
} from "@/lib/client-api";
import { formatCountdown, formatEventDate, formatPrice } from "@/lib/format";
import {
  cardAmountFor,
  clampPoints,
  formatPoints,
  maxSpendablePoints,
} from "@/lib/loyalty-points";
import { storeReservationMeta } from "@/lib/reservation-meta";

type ReserveFormProps = {
  event: EventDto;
  seatId: string;
};

type FieldErrors = { customerName?: string; email?: string };

type Hold = {
  reservationId: string;
  amount: number;
  expiresAt: number;
};

type LoyaltyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; balance: number };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOYALTY_DEBOUNCE_MS = 400;

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
  const [hold, setHold] = useState<Hold | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [expired, setExpired] = useState(false);
  const [loyalty, setLoyalty] = useState<LoyaltyState>({ status: "idle" });
  const [pointsInput, setPointsInput] = useState(0);

  const amount = hold?.amount ?? event.price;
  const maxPoints =
    loyalty.status === "ready"
      ? maxSpendablePoints(amount, loyalty.balance)
      : 0;

  useEffect(() => {
    idempotencyKey.current = crypto.randomUUID();
  }, []);

  useEffect(() => {
    const normalized = email.trim();

    if (!EMAIL_PATTERN.test(normalized)) {
      setLoyalty({ status: "idle" });
      setPointsInput(0);
      return;
    }

    let cancelled = false;
    setLoyalty({ status: "loading" });

    const timer = window.setTimeout(() => {
      getLoyalty(normalized)
        .then((balance) => {
          if (!cancelled) {
            setLoyalty({ status: "ready", balance: balance.points });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLoyalty({ status: "unavailable" });
          }
        });
    }, LOYALTY_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [email]);

  useEffect(() => {
    setPointsInput((current) => clampPoints(current, maxPoints));
  }, [maxPoints]);

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

  useEffect(() => {
    if (!hold) {
      setRemainingMs(0);
      return;
    }

    const tick = () => {
      const remaining = Math.max(0, hold.expiresAt - Date.now());
      setRemainingMs(remaining);

      if (remaining === 0) {
        setHold(null);
        setExpired(true);
        setFormError(null);
      }
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [hold]);

  const locked = lockedUntil > Date.now();
  const disabled = pending || locked || expired;
  const fieldsLocked = hold !== null;

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

  async function startPayment(activeHold: Hold) {
    const checkout = await startCheckout(activeHold.reservationId, pointsInput);

    storeReservationMeta(activeHold.reservationId, {
      eventId: event.id,
      seatId,
    });
    window.location.assign(checkout.url);
  }

  async function createHold() {
    if (!idempotencyKey.current) {
      idempotencyKey.current = crypto.randomUUID();
    }

    const reservation = await createReservation(
      {
        eventId: event.id,
        seatId,
        customerName: customerName.trim(),
        email: email.trim(),
      },
      idempotencyKey.current,
    );

    const expiresAt = Date.parse(reservation.expiresAt);

    if (
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(reservation.amount) ||
      reservation.amount <= 0
    ) {
      throw new ApiError(
        200,
        "INVALID_RESPONSE",
        "Serwer nie zwrócił ważności rezerwacji.",
      );
    }

    if (expiresAt <= Date.now()) {
      setHold(null);
      setExpired(true);
      return;
    }

    const nextHold = {
      reservationId: reservation.reservationId,
      amount: reservation.amount,
      expiresAt,
    };
    setHold(nextHold);
    setRemainingMs(expiresAt - Date.now());
  }

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (disabled) {
      return;
    }

    setFormError(null);
    setSeatTaken(false);

    if (hold) {
      setPending(true);
      try {
        await startPayment(hold);
      } catch (error) {
        await handleError(error);
      } finally {
        setPending(false);
      }
      return;
    }

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setPending(true);
    try {
      await createHold();
    } catch (error) {
      await handleError(error);
    } finally {
      setPending(false);
    }
  }

  async function reserveAgain() {
    if (pending || locked) {
      return;
    }

    setExpired(false);
    setFormError(null);
    setSeatTaken(false);
    idempotencyKey.current = crypto.randomUUID();

    setPending(true);
    try {
      await createHold();
    } catch (error) {
      await handleError(error);
    } finally {
      setPending(false);
    }
  }

  async function handleError(error: unknown) {
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
        setHold(null);
        idempotencyKey.current = crypto.randomUUID();
        setFormError("Odświeżyliśmy sesję rezerwacji. Spróbuj jeszcze raz.");
        break;
      case "EVENT_NOT_FOUND":
        setFormError("Ten seans nie jest już dostępny.");
        break;
      case "RESERVATION_EXPIRED":
        setHold(null);
        setExpired(true);
        setFormError(null);
        break;
      case "RESERVATION_ALREADY_PAID":
        setFormError("Ta rezerwacja jest już opłacona. Otwieramy bilet…");

        if (hold) {
          void getReservation(hold.reservationId)
            .then((reservation) => {
              if (reservation.code) {
                router.push(
                  `/reservations/${encodeURIComponent(reservation.code)}`,
                );
              }
            })
            .catch(() => {
              setFormError(
                "Ta rezerwacja jest już opłacona. Odśwież stronę, aby zobaczyć bilet.",
              );
            });
        }
        break;
      case "PAYMENT_UNAVAILABLE":
        setFormError(
          "Płatności online są chwilowo niedostępne. Spróbuj ponownie za chwilę.",
        );
        break;
      case "INSUFFICIENT_POINTS": {
        try {
          const balance = await getLoyalty(email.trim());
          setLoyalty({ status: "ready", balance: balance.points });
          setPointsInput((current) =>
            clampPoints(
              current,
              maxSpendablePoints(hold?.amount ?? event.price, balance.points),
            ),
          );
          setFormError(
            "Saldo punktów się zmieniło. Sprawdziliśmy je ponownie — potwierdź kwotę.",
          );
        } catch {
          setLoyalty({ status: "unavailable" });
          setPointsInput(0);
          setFormError(
            "Program lojalnościowy jest chwilowo niedostępny. Możesz zapłacić kartą.",
          );
        }
        break;
      }
      case "POINTS_LIMIT_EXCEEDED":
        setPointsInput((current) => clampPoints(current, maxPoints));
        setFormError("Punktami można pokryć najwyżej połowę biletu.");
        break;
      case "CHECKOUT_IN_PROGRESS":
        setFormError(
          "Trwa już płatność z innym podziałem punktów. Dokończ ją lub spróbuj ponownie bez zmiany punktów.",
        );
        break;
      case "LOYALTY_UNAVAILABLE":
        setLoyalty({ status: "unavailable" });
        setPointsInput(0);
        setFormError(
          "Program lojalnościowy jest chwilowo niedostępny. Możesz zapłacić kartą.",
        );
        break;
      case "RESERVATION_NOT_FOUND":
        setHold(null);
        idempotencyKey.current = crypto.randomUUID();
        setFormError("Nie znaleźliśmy Twojej rezerwacji. Spróbuj ponownie.");
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
    "mt-2 w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-3 text-sm text-white placeholder:text-zinc-600 transition-colors focus:border-secondary/60 focus:outline-none read-only:opacity-70";
  const pointsInputClass =
    "w-full rounded-xl border border-white/10 bg-ink/60 px-4 py-3 text-sm text-white transition-colors focus:border-secondary/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="space-y-5">
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
              Sala
            </dt>
            <dd className="mt-1 font-semibold text-white">{event.venue}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              Miejsce
            </dt>
            <dd className="mt-1 font-semibold text-secondary">{seatId}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              Cena
            </dt>
            <dd className="mt-1 font-semibold text-secondary">
              {formatPrice(hold?.amount ?? event.price)}
            </dd>
          </div>
        </dl>

        {hold ? (
          <p
            role="timer"
            className="mt-5 rounded-xl border border-secondary/30 bg-secondary/10 px-4 py-3 text-sm text-white"
          >
            Miejsce zablokowane jeszcze przez{" "}
            <span className="font-mono text-base font-bold text-secondary">
              {formatCountdown(remainingMs)}
            </span>
            . Kliknij „Zapłać{" "}
            {formatPrice(cardAmountFor(hold.amount, pointsInput))}”, aby przejść
            do płatności Stripe.
          </p>
        ) : null}
      </div>

      {expired ? (
        <div role="alert" className="surface-card p-6 sm:p-8">
          <p className="eyebrow text-secondary">Rezerwacja wygasła</p>
          <h2 className="mt-3 text-2xl font-black text-white">
            Miejsce zostało zwolnione
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">
            Minął czas na dokończenie rezerwacji, więc miejsce {seatId} wróciło
            do puli wolnych foteli. Możesz spróbować jeszcze raz.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => void reserveAgain()}
              disabled={pending || locked}
              className="btn-primary justify-center disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Rezerwujemy…" : "Zarezerwuj ponownie"}
            </button>
            <a
              href={`/events/${event.id}`}
              className="btn-ghost justify-center"
            >
              Wybierz inne miejsce
            </a>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          noValidate
          className="surface-card space-y-5 p-6 sm:p-8"
        >
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
              readOnly={fieldsLocked || pending}
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
              readOnly={fieldsLocked || pending}
              onChange={(changeEvent) => {
                setEmail(changeEvent.target.value);
                setLoyalty({ status: "idle" });
                setPointsInput(0);
                setFormError(null);
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
              {hold
                ? "Dane są zablokowane do czasu zakończenia płatności."
                : "Po opłaceniu zobaczysz bilet z kodem na ekranie."}
            </p>
          </div>

          {loyalty.status === "loading" ? (
            <p className="text-xs text-zinc-500">
              Sprawdzamy punkty lojalnościowe…
            </p>
          ) : null}

          {loyalty.status === "ready" && maxPoints > 0 ? (
            <div className="rounded-xl border border-secondary/20 bg-secondary/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="points"
                  className="text-sm font-semibold text-white"
                >
                  Użyj punktów
                </label>
                <span className="text-xs text-zinc-400">
                  Masz {formatPoints(loyalty.balance)}
                </span>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  id="points"
                  name="points"
                  type="number"
                  min={0}
                  max={maxPoints}
                  step={1}
                  inputMode="numeric"
                  value={pointsInput}
                  disabled={pending}
                  onChange={(changeEvent) =>
                    setPointsInput(
                      clampPoints(Number(changeEvent.target.value), maxPoints),
                    )
                  }
                  className={pointsInputClass}
                />
                <button
                  type="button"
                  onClick={() => setPointsInput(maxPoints)}
                  disabled={pending}
                  className="btn-ghost justify-center whitespace-nowrap px-4 py-3 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Użyj maks.
                </button>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Możesz wykorzystać maksymalnie {formatPoints(maxPoints)}
                {" (1 pkt = 1 gr)."}
              </p>
              <dl className="mt-4 space-y-2 border-t border-white/10 pt-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-zinc-400">Cena biletu</dt>
                  <dd className="font-semibold text-white">
                    {formatPrice(amount)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-zinc-400">Punkty</dt>
                  <dd className="font-semibold text-secondary">
                    −{formatPrice(pointsInput)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2">
                  <dt className="font-semibold text-white">Do zapłaty kartą</dt>
                  <dd className="font-semibold text-secondary">
                    {formatPrice(cardAmountFor(amount, pointsInput))}
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}

          {loyalty.status === "ready" && maxPoints === 0 ? (
            <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-zinc-400">
              Brak punktów do wykorzystania — zapłacisz kartą.
            </p>
          ) : null}

          {loyalty.status === "unavailable" ? (
            <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs text-zinc-400">
              Program lojalnościowy jest chwilowo niedostępny. Możesz zapłacić
              kartą.
            </p>
          ) : null}

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
            className="btn-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? (
              hold ? (
                "Przekierowujemy do płatności…"
              ) : (
                "Blokujemy miejsce…"
              )
            ) : locked ? (
              `Poczekaj ${secondsLeft} s`
            ) : hold ? (
              `Zapłać ${formatPrice(cardAmountFor(hold.amount, pointsInput))}`
            ) : (
              <>
                Zarezerwuj miejsce
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
        </form>
      )}
    </div>
  );
}
