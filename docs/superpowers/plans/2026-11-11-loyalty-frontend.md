# Loyalty Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the etap III loyalty UI to the existing Technikino shop: balance lookup, pay-with-points on the reservation screen, and the card/points summary on the payment and ticket pages.

**Architecture:** Extend the existing etap II reservation flow and its retrying client instead of adding a parallel checkout. Pure helpers own the points split math, the client API owns transport, and presentational components own the summary. The only backend change is widening the internal paid-ticket query so the ticket page can render the summary without touching the public API contract.

**Tech Stack:** Bun, Next.js, React, TypeScript, Drizzle, Tailwind, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-11-loyalty-frontend-design.md`

## Global Constraints

- Polish copy in every user-facing string.
- Money is integer grosze; 1 point = 1 grosz; never use floating point.
- The client never sends a price or card amount, only an integer `points` value.
- An omitted `points` value must behave exactly like etap II (no request body, no Voucherify dependency).
- Retry only `NETWORK_ERROR` with the existing 5 s timeout and 300/600/1200 ms backoff; surface 4xx/5xx immediately.
- No new dependencies and no secrets/emails in logs.
- Do not change the public API response shape.
- Work on `feat/loyalty-frontend`; use conventional commits.

## Review Focus

- Voucherify unavailable: the reservation screen must still allow a card-only checkout and must not crash or block the form.
- Balance changed between preview and checkout: `409 INSUFFICIENT_POINTS` must refresh the balance, clamp the field and keep the user on our page.
- Split changed while a Stripe session is open: `409 CHECKOUT_IN_PROGRESS` must show a clear message, never redirect.
- Malformed points input (negative, fractional, above the cap): clamp locally and let the server refuse gracefully.
- Ticket opened from the email on another device: the summary must come from the database, not from localStorage or the query string.

---

### Task 1: Loyalty client API

**Files:**
- Modify: `src/lib/client-api.ts`
- Test: `tests/client-api.test.ts`

**Interfaces:**
- Consumes: existing `requestJson`, `isRecord`, `ApiError`, `toErrorCode`.
- Produces:
  - `export type LoyaltyBalance = { email: string; points: number }`
  - `export function getLoyalty(email: string): Promise<LoyaltyBalance>`
  - `export function startCheckout(reservationId: string, points?: number): Promise<CheckoutResult>`
  - `ReservationState` gains `pointsUsed: number` and optional `pointsEarned?: number`.
  - `ApiErrorCode` gains `"LOYALTY_UNAVAILABLE" | "POINTS_LIMIT_EXCEEDED" | "INSUFFICIENT_POINTS" | "CHECKOUT_IN_PROGRESS"`.

- [ ] **Step 1: Write failing client tests**

Add to `tests/client-api.test.ts`:

```ts
test("fetches a loyalty balance", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/loyalty?email=jan%40example.com");
    return jsonResponse({ email: "jan@example.com", points: 1000 });
  }) as typeof fetch;

  expect(await getLoyalty("jan@example.com")).toEqual({
    email: "jan@example.com",
    points: 1000,
  });
});

test("rejects a malformed loyalty balance", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({ email: "jan@example.com", points: "1000" })) as typeof fetch;

  const error = await getLoyalty("jan@example.com").catch((caught) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.code).toBe("INVALID_RESPONSE");
});

test("sends points only when supplied", async () => {
  const bodies: Array<string | undefined> = [];

  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    bodies.push(init?.body as string | undefined);
    return jsonResponse({ url: "https://checkout.stripe.com/cs_test_1" });
  }) as typeof fetch;

  await startCheckout("res-1", 1000);
  await startCheckout("res-1");

  expect(bodies).toEqual(['{"points":1000}', undefined]);
});

test("reads the points split from a reservation", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      status: "paid",
      amount: 3200,
      expiresAt: "2026-10-28T12:15:00.000Z",
      code: "ABC12345",
      pointsUsed: 1000,
      pointsEarned: 220,
    })) as typeof fetch;

  const result = await getReservation("res-1");

  expect(result.pointsUsed).toBe(1000);
  expect(result.pointsEarned).toBe(220);
});

test("exposes loyalty checkout refusals", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({ error: "Not enough loyalty points.", code: "INSUFFICIENT_POINTS" }, 409)) as typeof fetch;

  const error = await startCheckout("res-1", 1000).catch((caught) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(409);
  expect(error.code).toBe("INSUFFICIENT_POINTS");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/client-api.test.ts`
Expected: FAIL — `getLoyalty` is not exported, and `startCheckout` ignores its second argument.

- [ ] **Step 3: Implement the client changes**

In `src/lib/client-api.ts`:
- Extend `ApiErrorCode` and add the four new codes to the `toErrorCode` array.
- Add `LoyaltyBalance`, `getLoyalty`.
- Add `pointsUsed: number` and `pointsEarned?: number` to `ReservationState`.
- In `getReservation`, require `typeof payload.pointsUsed === "number"` and accept `pointsEarned` only when it is a number.
- In `startCheckout`, add the optional `points` argument; when it is `undefined` keep the existing `{ method: "POST" }` only, otherwise send JSON `{ points }`.

- [ ] **Step 4: Update existing reservation mocks**

Add `pointsUsed: 0` to the mock payloads in the existing `"reads a reservation state"` and `"keeps a held reservation without a code"` tests, and include `pointsUsed: 0` in that expected object.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `bun test tests/client-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/client-api.ts tests/client-api.test.ts
git commit -m "feat(web): add loyalty client api and points checkout"
```

---

### Task 2: Points split helpers

**Files:**
- Create: `src/lib/loyalty-points.ts`
- Test: `tests/loyalty-points.test.ts`

**Interfaces:**
- Produces:
  - `export function maxSpendablePoints(amount: number, balance: number): number`
  - `export function clampPoints(raw: number, max: number): number`
  - `export function cardAmountFor(amount: number, points: number): number`
  - `export function formatPoints(points: number): string`

- [ ] **Step 1: Write failing helper tests**

Create `tests/loyalty-points.test.ts` with assertions including: `maxSpendablePoints(3200, 1000) === 1000`, `maxSpendablePoints(3200, 9999) === 1600`, `maxSpendablePoints(0, 500) === 0`, `maxSpendablePoints(3200, -5) === 0`, `maxSpendablePoints(Number.NaN, 500) === 0`; `clampPoints(1200, 1000) === 1000`, `clampPoints(-5, 1000) === 0`, `clampPoints(12.9, 1000) === 12`, `clampPoints(Number.NaN, 1000) === 0`; `cardAmountFor(3200, 1000) === 2200`, `cardAmountFor(3200, 0) === 3200`, `cardAmountFor(3200, 5000) === 0`; `formatPoints(1000) === "1000 pkt"`, `formatPoints(-5) === "0 pkt"`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun test tests/loyalty-points.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

`maxSpendablePoints` returns 0 for non-finite values or a non-positive amount/balance, otherwise `Math.min(Math.floor(amount / 2), Math.floor(balance))`. `clampPoints` floors and clamps to `[0, max]` (0 when either input is non-finite). `cardAmountFor` returns `Math.max(0, amount - points)` with the same integer guards. `formatPoints` returns `${clamped} pkt` using `clampPoints(points, Number.MAX_SAFE_INTEGER)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun test tests/loyalty-points.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/loyalty-points.ts tests/loyalty-points.test.ts
git commit -m "feat(web): add loyalty points helpers"
```

---

### Task 3: Paid-ticket query returns the purchase summary

**Files:**
- Modify: `src/lib/reservations.ts`
- Test: `tests/reservations.test.ts`

**Interfaces:**
- Produces: `PaidTicket` becomes `{ code: string; eventId: string; seatId: string; amount: number; pointsUsed: number; pointsEarned: number }`.
- Consumes: `getPaidTicketByCode(db, code)` keeps its signature and paid-only guard.

- [ ] **Step 1: Update the failing backend test**

In `tests/reservations.test.ts`, inside `describe("getPaidTicketByCode")`, after the successful purchase set the points snapshot:

```ts
db.update(reservations)
  .set({ pointsUsed: 1000, pointsEarned: 220 })
  .where(eq(reservations.code, purchase.code))
  .run();

expect(getPaidTicketByCode(db, purchase.code)).toEqual({
  code: purchase.code,
  eventId: duneEvent.id,
  seatId: "C3",
  amount: 3200,
  pointsUsed: 1000,
  pointsEarned: 220,
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test tests/reservations.test.ts -t getPaidTicketByCode`
Expected: FAIL — the result has no `amount`, `pointsUsed` or `pointsEarned`.

- [ ] **Step 3: Widen the query and type**

In `src/lib/reservations.ts`, select `amount`, `pointsUsed` and `pointsEarned` in `getPaidTicketByCode` and return `pointsEarned: reservation.pointsEarned ?? 0`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test tests/reservations.test.ts -t getPaidTicketByCode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reservations.ts tests/reservations.test.ts
git commit -m "feat(api): expose purchase summary for ticket pages"
```

---

### Task 4: Shared summary on the ticket page

**Files:**
- Create: `src/components/purchase-summary.tsx`
- Modify: `src/app/reservations/[id]/confirmation.tsx`
- Modify: `src/app/reservations/[id]/page.tsx`

**Interfaces:**
- Consumes: `formatPrice` from `src/lib/format.ts`; `cardAmountFor`, `formatPoints` from `src/lib/loyalty-points.ts`; `PaidTicket` from Task 3.
- Produces: `export type PurchaseSummaryData = { amount: number; pointsUsed: number; pointsEarned?: number }`; `Confirmation` gains `summary?: PurchaseSummaryData`.

- [ ] **Step 1: Add the presentational component**

`PurchaseSummary` renders three cells matching the existing ticket card style: "Zapłacono kartą" → `formatPrice(cardAmountFor(amount, pointsUsed))`, "Wykorzystane punkty" → `` `${formatPoints(pointsUsed)} (${formatPrice(pointsUsed)})` ``, "Zdobyte punkty" → `pointsEarned === undefined ? "—" : formatPoints(pointsEarned)`.

- [ ] **Step 2: Render the summary in `Confirmation`**

Add the optional `summary` prop and render `<PurchaseSummary {...summary} />` under the ticket card when it is present.

- [ ] **Step 3: Pass the summary from the ticket page**

In `src/app/reservations/[id]/page.tsx`, pass `summary={{ amount: ticket.amount, pointsUsed: ticket.pointsUsed, pointsEarned: ticket.pointsEarned }}`.

- [ ] **Step 4: Verify formatting and types**

Run: `bun run lint && bun run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/components/purchase-summary.tsx "src/app/reservations/[id]/confirmation.tsx" "src/app/reservations/[id]/page.tsx"
git commit -m "feat(web): show the purchase summary on the ticket page"
```

---

### Task 5: Pay with points on the reservation screen

**Files:**
- Modify: `src/app/reserve/reserve-form.tsx`

**Interfaces:**
- Consumes: `getLoyalty`, `startCheckout(id, points)`, `ApiError` codes from Task 1; `maxSpendablePoints`, `clampPoints`, `cardAmountFor`, `formatPoints` from Task 2.
- Produces: no exported API; the component keeps its existing `{ event, seatId }` props.

- [ ] **Step 1: Add the loyalty state and debounced fetch**

Track `loyalty` as `{ status: "idle" | "loading" | "unavailable" | "ready"; balance: number }` and `pointsInput` as a number. On email change, reset both. When the trimmed email matches `EMAIL_PATTERN`, wait 400 ms, call `getLoyalty(email)`, and set `ready` with the balance. Map `LOYALTY_UNAVAILABLE`, `VALIDATION_ERROR`, `RATE_LIMITED` and any other failure to `unavailable` without blocking the form. Clean up the timer on every email change.

- [ ] **Step 2: Clamp the split**

Compute `const amount = hold?.amount ?? event.price;` and `const maxPoints = loyalty.status === "ready" ? maxSpendablePoints(amount, loyalty.balance) : 0;`. Clamp `pointsInput` whenever `maxPoints` changes. Do not reset a valid value while the hold is created.

- [ ] **Step 3: Render the points panel**

When `loyalty.status === "ready" && maxPoints > 0`, show the balance, a number input (`min=0`, `max=maxPoints`, `step=1`, `inputMode="numeric"`), an "Użyj maks." button and the breakdown: "Cena biletu" `formatPrice(amount)`, "Punkty" `−${formatPrice(pointsInput)}`, "Do zapłaty kartą" `formatPrice(cardAmountFor(amount, pointsInput))`. Lock the input while `pending`. When `loyalty.status === "loading"` show a small "Sprawdzamy punkty…" line. When `unavailable` show the card-only note. Keep the panel below the email field and above the error/button block.

- [ ] **Step 4: Send the split and handle refusals**

Call `startCheckout(activeHold.reservationId, pointsInput)`. Change the button label to `Zapłać ${formatPrice(cardAmountFor(hold.amount, pointsInput))}` when a hold exists. Add error handling:
- `INSUFFICIENT_POINTS`: re-fetch `getLoyalty(email)`, clamp `pointsInput` to the fresh maximum and show "Saldo punktów się zmieniło. Sprawdziliśmy je ponownie — potwierdź kwotę."
- `POINTS_LIMIT_EXCEEDED`: clamp to `maxPoints` and show "Punktami można pokryć najwyżej połowę biletu."
- `CHECKOUT_IN_PROGRESS`: show "Trwa już płatność z innym podziałem punktów. Dokończ ją lub spróbuj ponownie bez zmiany punktów."
- `LOYALTY_UNAVAILABLE`: set `loyalty` to `unavailable`, reset `pointsInput` to 0 and show "Program lojalnościowy jest chwilowo niedostępny. Możesz zapłacić kartą."

- [ ] **Step 5: Verify**

Run: `bun run lint && bun run build`
Expected: both succeed.

- [ ] **Step 6: Manual smoke**

Run `bun run dev`, open a reservation, enter an email, confirm the balance appears, change the points, and confirm the button shows `event.price - points`. Confirm the layout still works with the loyalty panel hidden.

- [ ] **Step 7: Commit**

```bash
git add src/app/reserve/reserve-form.tsx
git commit -m "feat(web): pay for a reservation with loyalty points"
```

---

### Task 6: Points on the payment return pages

**Files:**
- Modify: `src/app/reservations/[id]/payment/success/payment-success.tsx`
- Modify: `src/app/reservations/[id]/payment/cancel/payment-cancel.tsx`

**Interfaces:**
- Consumes: `ReservationState.pointsUsed`/`pointsEarned` from Task 1; `cardAmountFor`, `formatPoints` from Task 2; `PurchaseSummary` from Task 4.
- Produces: no exported API.

- [ ] **Step 1: Show the split while a payment is pending**

In `payment-success.tsx`, keep the whole reservation in the `paid` state (`{ status: "paid"; reservation: ReservationState }`) instead of only the code. In the `pending` view show `formatPrice(cardAmountFor(reservation.amount, reservation.pointsUsed))` as the amount being confirmed and render `<PurchaseSummary amount={...} pointsUsed={...} />` under the state card.

- [ ] **Step 2: Show the summary on the paid ticket**

When the poll returns `paid`, render `<Confirmation code={reservation.code} eventId={meta?.eventId} seatId={meta?.seatId} summary={{ amount, pointsUsed, pointsEarned }} />`.

- [ ] **Step 3: Retry the locked split on cancel**

In `payment-cancel.tsx`, store the reservation in the `paid` state as well and pass the summary to `Confirmation`. In `payAgain`, call `startCheckout(reservationId, state.reservation.pointsUsed > 0 ? state.reservation.pointsUsed : undefined)`. Show the card amount and the locked points on the held view with `PurchaseSummary`.

- [ ] **Step 4: Recover from a changed balance**

Catch `INSUFFICIENT_POINTS` and `POINTS_LIMIT_EXCEEDED` in `payAgain`, call `load()` to refresh the reservation, and show "Saldo punktów się zmieniło. Kwota została zaktualizowana — spróbuj ponownie." The next click retries with the refreshed split (card-only when it was released).

- [ ] **Step 5: Verify**

Run: `bun run lint && bun run build`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add "src/app/reservations/[id]/payment/success/payment-success.tsx" "src/app/reservations/[id]/payment/cancel/payment-cancel.tsx"
git commit -m "feat(web): show loyalty points on payment return pages"
```

---

### Task 7: Whole-branch verification

**Files:** none (fix any failures in the files above).

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Run the linter**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: success.

- [ ] **Step 4: Manual loyalty smoke**

With `bun run dev` and `bun run dev:stripe`:
1. Reserve a seat with a Resend test address, spend 1000 points, pay with `4242 4242 4242 4242`.
2. Confirm the success page becomes the ticket and shows 22 zł card, 1000 points used, 220 points earned.
3. Open the ticket page directly and confirm the same summary.
4. Cancel a payment and confirm the retry reuses the same split.
5. Confirm a card-only reservation (points 0) still checks out when Voucherify is unconfigured.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(web): polish the loyalty frontend"
```

Only run this step if Step 1–4 required changes.
