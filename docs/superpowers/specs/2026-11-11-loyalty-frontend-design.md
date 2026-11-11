# Technikino — loyalty frontend design

Date: 2026-11-11
Branch: `feat/loyalty-frontend` (from `origin/feat/loyalty-points`)
Status: approved

## Goal

Extend the existing etap II shop with the etap III loyalty UI: show the
customer's Voucherify balance, let them pay part of the ticket with points,
and show the card/points summary on the ticket. Everything that worked in
etap I and etap II keeps working, and card-only checkout stays independent of
Voucherify.

## Approaches considered

1. **Extend the existing screens and client (chosen).** The reservation flow
   already creates a hold, starts checkout and polls the payment state. Loyalty
   is another input on that flow. This keeps the etap II path intact, reuses the
   retrying client and needs no new pages.
2. **A separate loyalty checkout page.** Rejected: it would duplicate the hold
   and timer logic, and the customer would have to get back to the reservation
   without creating a second hold. It also risks two payment flows diverging.
3. **Keep a local points wallet in the browser.** Rejected: Voucherify is the
   only balance authority, and a local balance would go stale and could be
   tampered with. The browser only previews the split; the server validates and
   debits it.

## Goals

- Show the live balance after the customer enters a valid email.
- Let the customer spend at most `min(balance, floor(amount / 2))` points,
  where 1 point = 1 grosz.
- Show ticket price, points and card amount, with a "Zapłać <card amount>"
  button.
- Show the same summary (card amount, points used, points earned) on the
  payment success page and the ticket page.
- Recover from a changed balance by refreshing and clamping the points.
- Keep card-only checkout available when Voucherify is unavailable.

## Non-goals

- No new API endpoints and no change to the public response shape.
- No loyalty balance cached in the app database or in the browser.
- No card payment fields on our pages; Stripe Checkout stays authoritative.
- No edits to the stages I/II reservation, rate-limit or webhook behaviour.

## Constraints

- All copy is Polish.
- Money stays integer grosze; never floating point.
- Client retries only network failures, with the existing 5 s timeout and
  300/600/1200 ms backoff. A 4xx/5xx refusal is surfaced immediately.
- The client never sends a price or card amount, only the integer points value.
- No secrets or customer emails in logs.
- No new dependencies.

## Design

### Client data layer (`src/lib/client-api.ts`)

- `getLoyalty(email)` → `{ email, points }`.
- `startCheckout(reservationId, points?)`: sends `{ points }` only when the
  argument is defined; an omitted value keeps the etap II body-less request.
- `ReservationState` gains `pointsUsed` and an optional `pointsEarned`.
- New error codes: `LOYALTY_UNAVAILABLE`, `POINTS_LIMIT_EXCEEDED`,
  `INSUFFICIENT_POINTS`, `CHECKOUT_IN_PROGRESS`.

### Points helpers (`src/lib/loyalty-points.ts`)

Pure, client-safe helpers so the split can be unit tested without a browser:

- `maxSpendablePoints(amount, balance)`.
- `clampPoints(raw, max)`.
- `cardAmountFor(amount, points)`.
- `formatPoints(points)`.

### Reservation screen (`/reserve`)

After a valid email is entered, fetch the balance with a short debounce. The
points panel appears only when the balance is available:

```
Punkty lojalnościowe                      Masz 1000 pkt
Użyj punktów   [ 1000 ]   [Użyj maks.]
Cena biletu                              32 zł
Punkty                                 −10 zł
Do zapłaty kartą                        22 zł
```

The field is capped at `min(balance, floor(amount / 2))` and uses the hold
amount once the hold exists, otherwise `event.price`. The button reads
"Zarezerwuj miejsce" before the hold and "Zapłać 22 zł" after it. If loyalty is
unavailable, the panel is replaced by a short card-only note and checkout
continues with points = 0.

Refusals: `INSUFFICIENT_POINTS` re-reads the balance and clamps the value;
`POINTS_LIMIT_EXCEEDED` clamps to the maximum; `CHECKOUT_IN_PROGRESS` explains
that the open payment locked another split; `LOYALTY_UNAVAILABLE` drops the
panel and offers a card-only retry.

### Payment return pages

- Success: the pending view shows the card amount and locked points; when the
  poll returns `paid`, the ticket shows the summary from the reservation state.
- Cancel: retry posts the reservation's `pointsUsed` (omitted when 0), so the
  open Stripe session and its split are reused. After the session/hold expires,
  a new attempt starts card-only. A balance refusal reloads the reservation and
  shows the refreshed amount.

### Ticket page (`/reservations/:code`)

The page renders the summary only for a paid reservation. The internal
`getPaidTicketByCode` query already confirms the paid status; it is extended to
return `amount`, `pointsUsed` and `pointsEarned` so the summary survives a
reload and works from the email link on another device. This is an internal
change only — the public API contract is untouched.

### Shared summary component

`src/components/purchase-summary.tsx` renders card amount, points used and
points earned. It is used by the ticket page, the success page and the cancel
page.

## What is left to the builder

Visual spacing inside the existing cards, exact Polish microcopy, and the
choice of inline SVG/arrow decorations. Follow the current Technikino tokens and
the patterns in `reserve-form.tsx` and `confirmation.tsx`.
