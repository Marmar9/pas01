<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project overview

Purpose: Cinema ticket reservation software ("Kino" variant of the PAS S01
project). This file is the single source of truth for etap I, etap II and
etap III requirements; the original assignment documents are not kept in the
repo.

Etap II goal (CEO request): customers pay online by card via Stripe instead of
paying at the entrance.
  1. The customer reserves a seat as in etap I and sees the price.
  2. Clicking "Zapłać" takes them to the Stripe Checkout page.
  3. After paying they return to the shop and see the ticket with its code.
  4. If they interrupt the payment, they return to the shop and may try again
     while the reservation is still valid.
Everything that worked in etap I MUST keep working.

Etap III goal (CEO request): a loyalty program. Customers collect points for
purchases and may pay part of the next ticket with points.
  1. A points account is keyed by the customer's email; a new customer starts
     with 1000 points.
  2. Every full złoty paid by card earns 10 points.
  3. At checkout the customer may spend points for at most half of the ticket
     price. 1 point = 1 grosz (100 points = 1 zł); the rest is paid by card
     through the etap II Stripe checkout.
  4. After purchase the customer receives an email with the ticket and a
     summary: the card amount, the points used and the points earned.
  5. Everything that worked in etap I and II MUST keep working. Checkout
     without points MUST behave exactly as in etap II.

Pricing: one price per seat per event (no per-seat tiers). Kino variant: the
price is for one seat at one screening, e.g. 3200 (32 zł).

## Contract

# API

GET  /api/events
  → { events: [...] }
  Each event includes:
    { id, title, description, venue, startsAt, rows, seatsPerRow, price }
  price: integer price per seat in grosze (3200 = 32 zł).

GET  /api/events/:id
  → { event, takenSeats: ["A2", "B1"] }
  event.price as above.

GET  /api/loyalty?email=…
  → 200 { email, points }
  email is trimmed and lowercased. points is the live loyalty-card balance
  from Voucherify; the app does not keep a local balance. An email that has
  never bought anything still has 1000 points: the first read enrolls the
  customer and the app credits the welcome points (see Welcome points). If
  that credit is not APPROVED in time, the read reports the current card
  balance and the "credit-welcome-points" job finishes it.
  Invalid email → 400 VALIDATION_ERROR.
  Voucherify is not configured or temporarily unavailable →
  503 LOYALTY_UNAVAILABLE.

POST /api/reservations
  headers: Idempotency-Key: <8-128 printable chars>
  body: { eventId, seatId, customerName, email }
  → 201 { reservationId, amount, expiresAt }
  amount: event.price copied when the hold is created; it never changes
  afterwards, even if the event price is edited.

GET  /api/reservations/:id
  → 200 { status, amount, expiresAt, code?, pointsUsed, pointsEarned? }
  status: "held" | "paid" | "expired"
  amount is the full ticket price captured at reservation time; it never
  changes when points are used.
  pointsUsed: integer points debited for the current/locked checkout attempt;
  0 when no points are used. The card amount is amount - pointsUsed.
  pointsEarned: present only when status is "paid"; the points credited for
  the purchase, computed as floor(cardAmount / 100) * 10.
  code is present only when status is "paid".
  Reading a hold whose expiresAt has passed may persist the transition to
  "expired" and enqueue a points restore for its open checkout attempt.

POST /api/reservations/:id/checkout
  body: { points?: integer }   # optional; defaults to 0
  Creates a Stripe Checkout Session for the reservation amount minus points.
  → 200 { url } (Stripe Checkout page)
  The reservation amount is always read from the database; the client never
  supplies the price or the card amount. The points account is the
  reservation's email; the client never supplies an email or another
  customer's identity. points must be a non-negative integer and is validated
  against the reservation and the Voucherify balance:
    points > floor(amount / 2) → 409 POINTS_LIMIT_EXCEEDED
    points > live Voucherify balance → 409 INSUFFICIENT_POINTS
    malformed points → 400 VALIDATION_ERROR
  Checkout locks the split for the open attempt: while a pending Checkout
  Session exists, repeated calls return its URL. If the body explicitly
  supplies a different points value, the call is refused with
  409 CHECKOUT_IN_PROGRESS. After the session expires or fails, a new attempt
  may choose points again.
  Refusals:
    404 RESERVATION_NOT_FOUND
    409 RESERVATION_ALREADY_PAID
    409 POINTS_LIMIT_EXCEEDED
    409 INSUFFICIENT_POINTS
    409 CHECKOUT_IN_PROGRESS
    410 RESERVATION_EXPIRED
    503 PAYMENT_UNAVAILABLE (Stripe is not configured or temporarily unavailable)
    503 LOYALTY_UNAVAILABLE (points > 0 and Voucherify is not configured or
        temporarily unavailable; no payable session is handed to the client)
  Without points (or with points = 0) checkout MUST work exactly as in
  etap II and MUST NOT depend on Voucherify.

POST /api/webhooks/stripe
  Receives Stripe events, including checkout.session.completed.
  The Stripe-Signature header MUST be verified against the raw request body
  (`await request.text()`) with `stripe.webhooks.constructEventAsync` (Bun's
  Stripe build uses async web crypto) and STRIPE_WEBHOOK_SECRET.
  Invalid signature → 400 INVALID_SIGNATURE.
  Handled events → 2xx. Processing MUST be idempotent because Stripe retries
  deliveries.

POST /api/reservations/:id/purchase
  Legacy etap I endpoint, kept only for backward compatibility.
  → { code }
  New web flows MUST use POST /api/reservations/:id/checkout.
  Responses carry Deprecation: true. Do not link to this endpoint from the
  new payment UI. It does not use points and does not award points; a
  reservation paid this way has pointsUsed = 0 and pointsEarned = 0.
  If a Checkout Session is still open for the reservation, the same
  transaction enqueues "restore-points" for its points and
  "expire-checkout-session" for the session; if that session is paid anyway,
  the webhook refunds it as a double charge.

Repeated POST /api/reservations with the same Idempotency-Key and payload
replays the original response (header Idempotency-Replayed: true); a different
payload under the same key → 409 IDEMPOTENCY_KEY_REUSED.

All endpoints: 429 RATE_LIMITED with Retry-After when the sliding-window IP limit
is exceeded, 500 INTERNAL_ERROR on unexpected failures.
Errors → { error, code, details? }
Response convention (unchanged from etap I): 2xx success, 4xx refusal with a
message, 5xx server error.

Reservation lifecycle:
  held --successful webhook--> paid
  held --expiresAt passes / checkout after expiry--> expired
  paid and expired are terminal. An expired hold no longer blocks its seat, so
  the seat may be held again by a new reservation.
  When a held reservation with a debited points attempt expires, its points
  are restored through the "restore-points" job.

# PAYMENTS (etap II)

Stripe Checkout, test mode only. Currency is PLN and every amount is an integer
number of grosze (3200 = 32 zł). Never use floating point for money.

Server-side environment variables (never in the repository, never sent to the
browser; .env.example documents them with placeholder values):
  STRIPE_SECRET_KEY=sk_test_…
  STRIPE_WEBHOOK_SECRET=whsec_…
  APP_URL=http://localhost:3000   # origin used to build Stripe return URLs
A STRIPE_SECRET_KEY that does not start with sk_test_ is refused (treated as
not configured). Without Stripe configuration, checkout and the webhook
endpoint answer 503 PAYMENT_UNAVAILABLE.

Stripe account setup (per team): each team creates its own Stripe account,
uses test-mode keys only, and adds the teacher to the account as a team member
with read-only access.

Checkout Session requirements:
  - mode: "payment"; line item quantity: 1
  - unit_amount: reservation.amount - reservation.pointsUsed (the card
    amount; equals reservation.amount when points = 0); currency: "pln"
  - customer_email: reservation email
  - client_reference_id: reservation id
  - metadata.reservationId: reservation id
  - metadata.pointsUsed: the split locked for this attempt (string)
  - success_url:
      ${APP_URL}/reservations/${reservationId}/payment/success?session_id={CHECKOUT_SESSION_ID}
  - cancel_url:
      ${APP_URL}/reservations/${reservationId}/payment/cancel
  - The client never supplies the price or amount.
  - Request option idempotencyKey: checkout:${reservationId}:${attempt},
    where attempt = 1 + number of payments already recorded for the
    reservation. Retries and concurrent calls for the same attempt get the
    same Stripe session back; a new attempt (after an expired/failed session)
    gets a new key.

Payment persistence:
  - Every Checkout Session attempt is recorded in a `payments` table:
    id, reservationId, stripeCheckoutSessionId (unique),
    stripePaymentIntentId, checkoutUrl, amount (the card amount of that
    session = reservation.amount - pointsUsed; equals reservation.amount
    when points = 0), pointsUsed, currency, status ("pending" | "paid" |
    "failed" | "expired" | "refunded"), stripeRefundId, createdAt, updatedAt.
    A "failed" row also records attempts whose points debit failed, so the
    next attempt gets a new idempotency key; its pointsUsed was never
    debited and is never restored.
  - At most one "pending" payment per reservation (partial unique index); its
    checkoutUrl is what repeated checkout calls return.
  - A "refunded" payment never goes back to "paid", even if a later event
    for the same session arrives.
  - Processed webhook event ids are stored in `stripe_events` (the inbox):
    id (primary key), type, outcome ("processed" | "ignored" | "failed"),
    failureReason, processedAt. A duplicate delivery is a no-op.
  - Rows with outcome "failed" are the dead-letter record of webhook events
    that need human review (unknown reservation, amount/currency mismatch,
    late payment, invalid session). They are never pruned. Other rows are
    pruned after 7 days inside the webhook transaction.
  - The webhook is the source of truth. Landing on success_url is not proof of
    payment.

Webhook processing (checkout.session.completed):
  - Verify the signature before parsing or trusting any field.
  - Require payment_status = "paid", currency "pln", and amount_total equal to
    the stored payment amount (reservation.amount - pointsUsed). For a
    points = 0 payment this is the same check as etap II. If the payment row
    is missing after a crash during checkout, recover pointsUsed from
    loyalty_operations by the Stripe session id before validating; if that
    fails, dead-letter the event.
  - In one transaction: mark the payment paid, mark the reservation paid,
    issue the ticket code exactly once, store pointsEarned
    (floor(cardAmount / 100) * 10) and enqueue "credit-points" and
    "send-ticket-email" (outbox). If the reservation is already paid,
    acknowledge the event without issuing a second code, a second points
    credit or a second email.
  - Never mark a reservation paid from an unverified or amount-mismatched event.
  - Log unknown reservation ids and amount mismatches; do not retry permanent
    failures forever (acknowledge them with 2xx so Stripe stops retrying).
  - payment_status other than "paid" (async methods) is acknowledged without
    changes; checkout.session.async_payment_succeeded completes it later.
  - A payment that arrives after the hold expired is recorded as paid for
    reconciliation, but the reservation stays expired and gets no code and no
    points. In the same transaction a refund job is enqueued (outbox) and the
    points of that payment are restored, so the customer is made whole
    automatically.
  - A ticket paid by Stripe is issued in the same transaction that marks its
    payment paid. So a paid session for a reservation that is already paid,
    whose payment row was not already "paid"/"refunded", did not buy the
    ticket (another session or the legacy purchase did): it is a double
    charge. The first ticket is kept, a refund job is enqueued for this
    payment in the same transaction, its points are restored and it earns no
    points. The same session reported twice (e.g. completed +
    async_payment_succeeded) is not a double charge.
  - A paid session whose payment row is "failed" or "expired" was abandoned
    by the checkout saga (see Sagas and compensation). It is recorded as paid,
    refunded and its points restored in the same transaction; it never issues
    a ticket (outcome "failed", reason payment_abandoned).

Refunds (background job "refund-payment"):
  - Job id: refund:${paymentId}; input: { paymentId }. Enqueueing the same
    payment twice keeps one job.
  - The worker calls stripe.refunds.create({ payment_intent, amount }) with
    amount = the payment's card amount and idempotencyKey = the job id,
    outside any database transaction, then marks the payment "refunded" with
    its stripeRefundId and acks the job.
  - The points part of that payment is restored by the "restore-points" job,
    enqueued in the same transaction as the refund job.
  - A payment that is already "refunded" is acked without calling Stripe.
    Stripe errors or missing Stripe configuration leave the job for a retry
    (backoff, max 5 attempts, then dead letter).

Other handled webhook events:
  - checkout.session.expired → payment "expired" and enqueue
    "restore-points" for its debited points.
  - checkout.session.async_payment_failed → payment "failed" and enqueue
    "restore-points" for its debited points.
  Both only move a "pending" payment, so out-of-order events never regress a
  paid one. Unrelated event types are acknowledged and ignored.

Local webhook testing:
  bun run dev:stripe   # next dev + stripe listen (key from .env.local)
  or manually:
  stripe listen --forward-to localhost:3000/api/webhooks/stripe \
    --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired
  Put the printed whsec_… value into STRIPE_WEBHOOK_SECRET.
  On the deployed environment (Vercel), add /api/webhooks/stripe as a
  test-mode endpoint in the Stripe Dashboard and store its signing secret in
  the server env.

Test cards:
  4242 4242 4242 4242  → success
  4000 0000 0000 0002  → declined
  4000 0025 0000 3155  → 3D Secure
  Any future expiry date, any 3-digit CVC.

# LOYALTY (etap III)

Voucherify is the source of truth for the customer's balance. Our database
only snapshots pointsUsed/pointsEarned for a reservation/payment and records
every Voucherify mutation, so our side can make retries idempotent
(Voucherify itself does not deduplicate balance changes). The local records
are never used as the balance authority.

Rules:
  - The points account is identified by the normalized (trimmed, lowercased)
    email address.
  - A new member receives 1000 points. Loyalty v2 cards have no starting
    balance, so the app credits them once, when it enrolls the member (see
    Welcome points). Members enrolled elsewhere (e.g. marketing's POS) get no
    welcome credit from the app.
  - Earning: 10 points per full złoty paid by card:
    pointsEarned = floor(cardAmount / 100) * 10. The part paid with points
    earns nothing.
  - Spending: 1 point = 1 grosz. At most floor(amount / 2) points may be
    spent on one ticket; the card amount is amount - points.
  - Points are debited when the Checkout Session is created, because the
    Stripe session itself is for the reduced amount.
  - Points are earned only when the Stripe webhook confirms a paid first
    payment for the reservation.
  - Example (Kino): a new customer with 1000 points buys a 3200 ticket,
    spends 1000 points (10 zł), pays 2200 (22 zł) by card and earns 220
    points.

Voucherify account setup (per team): create your own Voucherify account and
work in a Sandbox project. In the Loyalty hub (Loyalty v2) create a program
(lprg_...) with one active point wallet / card definition (lcdef_...) and the
active earning rule a program needs to be activated; the app awards points
itself through card adjustments, so the earning rule's trigger is not used by
the app. The program must be ACTIVE and inside its validity window. The
customer source_id is the normalized email. Marketing also uses the same
Voucherify account, so it remains the source of truth.
Note: zadanie.md points to the legacy POST /v1/loyalties/members/{memberId}/
balance endpoint; this project deliberately uses Loyalty v2 instead, because
the v1 loyalty API is deprecated (maintenance mode).

Server-side environment variables (never in the repository, never sent to the
browser; .env.example documents them with placeholder values):
  VOUCHERIFY_APP_ID=…
  VOUCHERIFY_SECRET_KEY=…
  VOUCHERIFY_LOYALTY_PROGRAM_ID=lprg_…
  VOUCHERIFY_LOYALTY_CARD_DEFINITION_ID=lcdef_…  # optional; which wallet to
                                                 # use if the program has
                                                 # several (default: first card)
  VOUCHERIFY_API_URL=https://api.voucherify.io   # optional override
  RESEND_API_KEY=re_…
  RESEND_FROM=onboarding@resend.dev               # default; see Resend setup

Without Voucherify configuration, GET /api/loyalty and checkout with
points > 0 answer 503 LOYALTY_UNAVAILABLE. Checkout with points = 0 still
works. Without Resend configuration the purchase and ticket still succeed;
the email job is retried and eventually dead-lettered.

Voucherify API (Loyalty v2, /v2/loyalties, through @voucherify/sdk):
  - Find the member: GET /v2/loyalties/programs/{programId}/memberships/
    {email}?identification_type=customer_source_id returns the member
    (lmbr_...) and its cards (lcrd_...) with card.balance.points. 404 means
    the customer does not exist or is not a member yet.
  - Enroll on 404: upsert the customer (POST /v1/customers with
    source_id = email), then POST /v2/loyalties/programs/{programId}/members
    with customer_identification { type: customer_source_id }. Enrollment
    MUST be idempotent: a customer can be a member only once (409
    member_already_exists), so concurrent first requests re-read the
    membership instead of creating a second card, and the welcome credit has
    one operation id per email.
  - Read the balance from the chosen card (card.balance.points).
  - Adjust points with
    POST /v2/loyalties/programs/{programId}/members/{memberId}/cards/
    {cardId}/points, body { points: <signed integer>, reason: <sourceId> }:
    a positive number creates an ADMIN_CREDIT, a negative one an ADMIN_DEBIT
    card transaction (lctx_...).
  - Every change is accepted as PENDING and processed asynchronously; it ends
    APPROVED (the points moved) or REJECTED (nothing moved, e.g. not enough
    points). A 200 is never proof that points moved. The accepted
    transaction id is stored on the loyalty_operations row and its status
    is read from GET .../cards/{cardId}/transactions (newest 100).
  - Every mutation carries a sourceId derived from our own ids, sent as the
    transaction reason (the only free field; the body accepts nothing else):
      spend:   loyalty:spend:<stripeCheckoutSessionId>
      earn:    loyalty:earn:<reservationId>
      restore: loyalty:restore:<stripeCheckoutSessionId>
      welcome: loyalty:welcome:<sha256(email), 32 hex chars>
  - The adjust endpoint has NO server-side idempotency: there is no
    Idempotency-Key header and the reason is not unique, so the same request
    sent twice changes the balance twice. Idempotency is built on our side: a
    loyalty_operations row is written before the call, a "done" operation is
    never sent again, a known transaction id is looked up instead of
    re-sending, and an operation whose response was lost is re-sent only
    after no non-rejected transaction with its reason was found on the card
    (after the settle window). Never retry a balance change blindly.
  - Voucherify Sandbox allows at most 100 API calls per hour. Cache
    GET /api/loyalty balances briefly (e.g. 30-60 s), coalesce reads, keep
    writes to one call per operation and invalidate the cached balance after
    every successful mutation. On 429/5xx/network errors, synchronous
    checkout returns 503 LOYALTY_UNAVAILABLE and never hands out a payable
    session (any session already created is expired); background jobs retry
    with the normal backoff. Never turn a single operation into a retry storm.
  - Voucherify processes balance changes asynchronously. Serialize balance
    mutations per member (one in flight per loyalty card) so spend, earn,
    restore and welcome never overlap. Reconcile an uncertain response by its
    transaction id or sourceId before retrying.
  - Call budget: a balance read is 1 call; the first read of a new email is
    about 4 calls plus the welcome credit; a debit is 1 call plus up to 3
    status lookups; a background credit/restore is 1 call plus 1 lookup on
    its next attempt.

Points persistence:
  - reservations.pointsUsed: the split locked for the current checkout
    attempt, 0 when no points are used, frozen when the reservation is paid,
    and reset to 0 when debited points are restored for an expired hold.
  - reservations.pointsEarned: set exactly once, in the webhook transaction
    that marks the reservation paid.
  - payments.pointsUsed: the points reserved for that specific Checkout
    Session (the split the session was created with), so a refund or late
    payment restores exactly the right amount. The matching
    loyalty_operations row records whether the debit actually happened; an
    attempt whose debit failed is marked "failed" and is never restored.
    payments.amount remains the card amount of that session
    (reservation.amount - payments.pointsUsed); for points = 0 it equals
    reservation.amount, preserving etap II.
  - loyalty_operations: the local record of every Voucherify mutation:
    id/sourceId (unique), reservationId (null for "welcome"), paymentId,
    type ("spend" | "earn" | "restore" | "welcome"), points, status
    ("pending" | "done" | "failed"), voucherifyTransactionId (lctx_..., set
    once Voucherify accepted the change), createdAt, updatedAt. "done" means
    the transaction was APPROVED, "failed" that it was REJECTED or refused,
    "pending" that the outcome is not known yet. It is not a balance source;
    it makes retries and reconciliation idempotent. A "done" operation is
    never applied twice.

Checkout with points:
  1. Validate the reservation, the points value and the customer's balance
     (a fresh cached read is acceptable; the debit is the authoritative
     balance check).
  2. Create the Stripe Checkout Session for the card amount
     (reservation.amount - points) with the usual idempotency key.
  3. Record the "spend" operation as "pending" with
     sourceId = loyalty:spend:<sessionId>, then debit the points in
     Voucherify and wait (about 3 s, up to 3 status lookups) for the debit
     transaction to leave PENDING. If the debit is refused or REJECTED
     (not enough points, 429, other 4xx), mark the operation "failed",
     record the attempt as a "failed" payment row (session id, card amount,
     pointsUsed, checkoutUrl) so the attempt counter advances, enqueue
     "expire-checkout-session" in the same transaction, leave
     reservations.pointsUsed unchanged and return 409 INSUFFICIENT_POINTS for
     a balance rejection or 503 LOYALTY_UNAVAILABLE otherwise; no charge is
     possible. If the outcome is unknown (timeout, 5xx, network with the
     transaction not found, or still PENDING after the wait), the operation
     stays "pending", the attempt is recorded as "failed" with both
     "expire-checkout-session" and "restore-points" enqueued, and 503
     LOYALTY_UNAVAILABLE is returned; the restore job settles the debit (see
     Sagas and compensation), so an applied debit is never lost.
  4. On an APPROVED debit, mark the operation "done" and in one transaction
     insert the "pending" payment row (session id, card amount, pointsUsed,
     checkoutUrl) and lock reservations.pointsUsed to that split. Then
     return { url }. If that transaction fails, leave
     reservations.pointsUsed unchanged, record the "failed" attempt and
     enqueue "restore-points" and "expire-checkout-session" for it, and
     return 503; never return the URL. If the payment row was
     not written, the "done" loyalty_operations row keyed by the session id
     is what the next request or worker reconciles.
  A session MUST NOT be handed to the browser before its points debit and
  payment row are recorded. If a crash interrupts this sequence, the
  recorded session id and loyalty_operations row let the next request or
  worker reconcile it.

Sagas and compensation:
  Each flow that touches several systems is a saga: a chain of local
  transactions and external calls, where every external step that can be
  undone has a compensating action. When a later step fails irreversibly,
  the completed steps are compensated in reverse order. Compensations are
  outbox jobs, enqueued in the same transaction that records the failure, so
  they survive a crash. A synchronous call may run one at once as a fast
  path (then its job is acked). Every compensation is idempotent.

  Checkout with points:
    step                                  compensation
    1. hold + validation (local)          (none; the hold expires)
    2. Stripe Checkout Session created    "expire-checkout-session"
    3. Voucherify debit (loyalty:spend)   "restore-points" (loyalty:restore)
    4. pending payment row (pivot)        after the pivot nothing is undone;
                                          the URL is handed out
  - Step 3 fails irreversibly (insufficient points, rejected) → compensate 2.
  - Step 3 is uncertain → compensate 2 and enqueue 3's compensation, which
    first settles whether the debit happened.
  - Step 4 fails → compensate 3 and 2.
  - A crash between steps leaves a "pending"/"done" spend without a payment
    row; the worker sweep (after a 60 s grace) records the failed attempt and
    enqueues both compensations.

  Payment confirmed (webhook): the paid transition is the pivot. Afterwards
  only retriable steps follow ("credit-points", "send-ticket-email"). A
  points credit or an email is never a reason to refund a ticket: a
  permanent failure is dead-lettered for human review. A paid session that
  must not produce a ticket (late, double, abandoned) is compensated with
  "refund-payment" + "restore-points" in the same transaction.

  Job "expire-checkout-session":
  - Job id: expire-session:${stripeCheckoutSessionId}; input: { sessionId }.
  - The worker retrieves the session and calls
    stripe.checkout.sessions.expire only while its status is "open"; a
    completed or already expired session is acked (the webhook settles a
    completed one). Stripe errors or missing Stripe configuration leave the
    job for a retry (backoff, max 5 attempts, then dead letter).

  Irreversible errors: a refusal that no retry can fix (Voucherify 4xx other
  than 429, Resend 4xx other than 429/quota/concurrent idempotent request)
  dead-letters its job immediately instead of using the remaining attempts.
  Transient errors (429, 5xx, network, timeout) are retried with backoff.

  Asynchronous Voucherify: an accepted change is PENDING until Voucherify
  APPROVES or REJECTS it; a PENDING operation stays "pending" and its job
  retries with backoff. When the response was lost (no transaction id), a
  sourceId missing from the card's transactions right after the call is not
  proof that the change was dropped: the operation may be declared not
  applied (and then re-sent or abandoned) only after it has been untouched
  for 60 s (LOYALTY_SETTLE_MS); until then the job retries with backoff.

  Welcome credit (enrollment saga): the app records the
  "credit-welcome-points" job (outbox) right before it enrolls a new member,
  so a lost enrollment response still leads to the credit. The read that
  enrolled the member tries the credit at once (fast path; the job is acked
  on APPROVED); otherwise the job retries it. There is nothing to
  compensate: a welcome credit that is refused for good is dead-lettered for
  human review.

Restoring points:
  - checkout.session.expired and checkout.session.async_payment_failed
    restore the debited points of that payment through the "restore-points"
    job and clear pointsUsed on a still-held reservation.
  - Lazy expiry of a held reservation with an open attempt also enqueues
    "restore-points".
  - The job worker also sweeps held reservations whose expiresAt has passed
    (even if nobody reads them) and enqueues "restore-points" for their open
    attempt; lazy expiry on read/create is only the fast path.
  - A late payment (successful payment for an expired hold) and a
    second/double paid session restore the points of that payment in the same
    transaction that enqueues the card refund.
  - Job id: restore-points:${paymentId}; input: { paymentId }. The restore
    job is idempotent per payment/session: a payment whose points are already
    restored is acked without another Voucherify call, and a payment whose
    "spend" operation is "failed" or missing (the debit never happened) is
    acked without a Voucherify call. A "pending" spend is first settled
    without re-sending it, by its transaction id (or its sourceId when the
    id is unknown): APPROVED → its points are restored; REJECTED → the spend
    is marked "failed" and the job is acked; still PENDING, or not found
    inside the settle window → the job retries; not found after the window →
    the spend is marked "failed" and the job is acked.

Earning points:
  - The webhook transaction that marks a reservation paid computes
    pointsEarned = floor(cardAmount / 100) * 10, stores it on the
    reservation, and enqueues "credit-points" (outbox) in the same
    transaction.
  - Job id: credit-points:${reservationId}; input: { reservationId }. If
    pointsEarned = 0, no credit job is enqueued.
  - The worker calls Voucherify with sourceId = loyalty:earn:<reservationId>
    and acks only after the credit is APPROVED. The loyalty_operations record
    (with the transaction id) prevents a retry from crediting twice. A Voucherify outage never blocks the ticket:
    the job retries (backoff, max 5 attempts, then dead letter).
  - Late payments and second paid sessions earn no points.

Resend:
  - The ticket email is sent by the "send-ticket-email" background job,
    enqueued in the same webhook transaction that issues the code. It
    contains the ticket code, event/seat details and the summary: card amount
    paid, points used, points earned.
  - Job id: email:ticket:${reservationId}; input: { reservationId }.
    Enqueueing the same reservation twice keeps one job.
  - The worker sends through Resend with idempotencyKey
    "ticket/<reservationId>" (valid for 24 h); a retry returns the original
    send instead of sending twice.
  - A Resend outage or refusal never affects the ticket. Transient errors
    (429, quota, concurrent idempotent request, 5xx, network) are retried and
    then dead-lettered; a permanent 4xx refusal (e.g. 422 validation_error
    for a recipient outside test mode, 401/403 for a bad or restricted key)
    is dead-lettered at once for human review. A sent email cannot be compensated, so it is the last step of the
    purchase saga. The ticket page always shows the same summary.
  - Resend test mode: without a verified domain, send from
    onboarding@resend.dev and only to the account owner or Resend test
    addresses. delivered@resend.dev is delivered; bounced@resend.dev is
    rejected (recipient does not exist). Any label after "+" works, e.g.
    delivered+jan@resend.dev, so each test can use a different customer.

Welcome points:
  - Job "credit-welcome-points": job id welcome-points:<sha256(email), 32 hex
    chars>; input: { email }. Enqueued (outbox) right before the app enrolls
    a member; enqueueing the same email twice keeps one job.
  - The credit is WELCOME_POINTS = 1000 with sourceId
    loyalty:welcome:<same hash>, applied through loyalty_operations like any
    other mutation, so it is credited at most once per email.

Local loyalty testing:
  - Use delivered+label@resend.dev as the customer email (and the Resend
    account owner address for real delivery).
  - Check the member's card balance and transactions (ADMIN_CREDIT /
    ADMIN_DEBIT, reason = our sourceId) in the Loyalty hub after a purchase.
  - A synthetic `stripe trigger checkout.session.completed` event does not
    match a real reservation amount/metadata; test the points path with a real
    Checkout Session through `stripe listen`.

# WEB INTERFACE

/                          event list; show price per seat
/events/:id                event by id; show price
/reserve?eventId=…&seatId=…  reservation form; show event.price, then the
                           amount returned by POST /api/reservations. After the
                           email is entered, fetch GET /api/loyalty?email=… and
                           show an "Użyj punktów" field with the maximum the
                           customer may spend: min(balance, floor(amount / 2)).
                           Show the price breakdown (ticket price, points,
                           card amount); the button shows the card amount,
                           e.g. "Zapłać 22 zł". Submit the chosen points with
                           POST /api/reservations/:id/checkout; if the balance
                           changed, refresh it and clamp the value. Card-only
                           checkout must remain available when loyalty is
                           unavailable.
/reservations/:id/payment/success
                           Stripe success return. Show "Płatność w toku…",
                           poll GET /api/reservations/:id, and replace the view
                           with the ticket when status becomes "paid".
                           Never trust the query string alone. The ticket
                           shows the code and the summary: card amount, points
                           used, points earned.
/reservations/:id/payment/cancel
                           Stripe cancel return. Show that payment was
                           interrupted and allow another checkout attempt while
                           the reservation is still valid; show the expired
                           state after the hold lapses. While the open session
                           exists the points split stays locked; after it
                           expires, a new attempt may choose points again.
/reservations/:code        ticket page with the reservation code and the same
                           purchase summary; the server looks the code up and
                           renders it only for a paid reservation

Ticket pages must render a code only after a paid status is confirmed.

# ETAP II WORK CARDS

Cards are independent (as in etap I); each starts against stubs.
  A. Checkout: price on the event list/detail and reservation screen, the
     "Zapłać 32 zł" button and the redirect to Stripe. Backed by price/amount
     and POST /api/reservations/:id/checkout (amount from the reservation). It
     provides the return URLs pointing at card C pages.
  B. Webhook: no direct UI; after payment the reservation becomes paid and
     gets a ticket code. Backed by POST /api/webhooks/stripe (signature
     verified). Testable without card A using events sent by the Stripe CLI
     (`stripe trigger checkout.session.completed`, or real sessions via
     `stripe listen`).
  C. Return to shop: "Płatność w toku…" page that turns into the ticket, and
     the cancel page with a retry. Backed by the return pages and
     GET /api/reservations/:id; it only reads reservation status, so it waits
     on neither A nor B.
The team lead owns the internal contract above (return URLs, payment
persistence) and turns entries from the risk list into additional cards.

# ETAP III WORK CARDS

Cards are independent (as in etap I and II); each starts against stubs.
  A. Loyalty account: show the balance after the customer enters an email and
     credit points after a purchase. Backed by GET /api/loyalty?email=… and
     the loyalty member/card in Voucherify. Testable without payments by
     checking the balance in the Voucherify dashboard.
  B. Pay with points: the "Użyj punktów" field in the cart, the live price
     breakdown, and "Zapłać <card amount>". Backed by POST
     /api/reservations/:id/checkout with { points }, the Voucherify debit and
     the reduced Stripe Checkout Session. It may assume every customer starts
     with 1000 points.
  C. Purchase confirmation: the ticket email and the same summary on the
     ticket page (card amount, points used, points earned). Backed by Resend,
     the "send-ticket-email" job and GET /api/reservations/:id with
     pointsUsed/pointsEarned. It only reads reservation data, so it waits on
     neither A nor B.
The team lead owns the internal contract (points storage, operation ids,
return URLs, payment persistence) and turns entries from the risk list into
additional cards.

## Techstack

runtime: bun
endpoints: Nextjs
db: Drizzle orm, better-sqlite3 driver
libraries: nanoid (reservation codes), object-hash (idempotency fingerprints),
@universal-rate-limit/nextjs (sliding-window IP rate limiting),
stripe (official Stripe Node SDK, server-side only),
@voucherify/sdk (official Voucherify JS SDK, server-side only),
resend (official Resend Node SDK, server-side only)
external services: Stripe (test mode), Voucherify (Sandbox project; at most
100 API calls per hour), Resend (test mode; without a verified domain it sends
only to the account owner and Resend test addresses)
dev tools: Stripe CLI (local webhook forwarding; not an app dependency)
background jobs: `jobs` table in the app's SQLite database; the worker polls
it every 5 s from src/instrumentation.ts inside the Next.js server process
(not during `next build`), so no separate process or queue service is needed.
Tasks: refund-payment, credit-points, restore-points, send-ticket-email,
expire-checkout-session, credit-welcome-points.

## Code quaity

1. Before commiting any changes validate changed files with biome linter "bun run lint" command. If linter fails, correct the mistakes.
2. All commits are to be made following the conventional commits specification: "
The key words “MUST”, “MUST NOT”, “REQUIRED”, “SHALL”, “SHALL NOT”, “SHOULD”, “SHOULD NOT”, “RECOMMENDED”, “MAY”, and “OPTIONAL” in this document are to be interpreted as described in RFC 2119.

    Commits MUST be prefixed with a type, which consists of a noun, feat, fix, etc., followed by the OPTIONAL scope, OPTIONAL !, and REQUIRED terminal colon and space.
    The type feat MUST be used when a commit adds a new feature to your application or library.
    The type fix MUST be used when a commit represents a bug fix for your application.
    A scope MAY be provided after a type. A scope MUST consist of a noun describing a section of the codebase surrounded by parenthesis, e.g., fix(parser):
    A description MUST immediately follow the colon and space after the type/scope prefix. The description is a short summary of the code changes, e.g., fix: array parsing issue when multiple spaces were contained in string.
    A longer commit body MAY be provided after the short description, providing additional contextual information about the code changes. The body MUST begin one blank line after the description.
    A commit body is free-form and MAY consist of any number of newline separated paragraphs.
    One or more footers MAY be provided one blank line after the body. Each footer MUST consist of a word token, followed by either a :<space> or <space># separator, followed by a string value (this is inspired by the git trailer convention).
    A footer’s token MUST use - in place of whitespace characters, e.g., Acked-by (this helps differentiate the footer section from a multi-paragraph body). An exception is made for BREAKING CHANGE, which MAY also be used as a token.
    A footer’s value MAY contain spaces and newlines, and parsing MUST terminate when the next valid footer token/separator pair is observed.
    Breaking changes MUST be indicated in the type/scope prefix of a commit, or as an entry in the footer.
    If included as a footer, a breaking change MUST consist of the uppercase text BREAKING CHANGE, followed by a colon, space, and description, e.g., BREAKING CHANGE: environment variables now take precedence over config files.
    If included in the type/scope prefix, breaking changes MUST be indicated by a ! immediately before the :. If ! is used, BREAKING CHANGE: MAY be omitted from the footer section, and the commit description SHALL be used to describe the breaking change.
    Types other than feat and fix MAY be used in your commit messages, e.g., docs: update ref docs.
    The units of information that make up Conventional Commits MUST NOT be treated as case-sensitive by implementors, with the exception of BREAKING CHANGE which MUST be uppercase.
    BREAKING-CHANGE MUST be synonymous with BREAKING CHANGE, when used as a token in a footer.
"
3. Each feature, bugfix, refactor or any other change purpose must be created on apropriate new branch (not master), the branch follows naming convention alike conventional commits specification: <CHANGE_TYPE>/<WHATS CHANGED>.
4. The agent uses git only for creating commits, branches and switching between them. Any other action is strictly forbidden.
5. use libraries where possible instead of implementing stuff yourself. you must look for popular, good libraries.

# Reliability rules

## Api

1. All api endpoints must be reliable (error resistant). Endpoits which must be idempotent (e.g. creating reservation) must implement idempotency using idempotency key.
2. Api endpoit which executes multiple write operations must use transactions.
3. Api endpoits are protected by sliding window rate limiting by ip. The Stripe webhook needs a high limit (or a dedicated allowance) so legitimate Stripe bursts are not dropped.
4. Payment and points state changes are written in a transaction and guarded
   by conditional updates, so retries and racing requests cannot issue two
   codes, sell the same seat twice or spend the same points twice.
5. Webhook handlers verify the signature before any database write and
   deduplicate by Stripe event id.
6. Client-supplied points are validated against the reservation amount and
   the live Voucherify balance before any debit; the client never supplies a
   money amount.

## Web

1. Any api calls made from the web client must retry 3 times if connection is broken or response dosent arrive after timespan of 5 seconds. If endpoint call is to be idempotent idempotency key is sent inside the request.
2. GET /api/reservations/:id polling on the payment success page uses the same timeout/retry client, keeps polling until the hold expires, and renders the ticket only after status "paid".
3. Client-side redirects to Stripe use only the { url } returned by POST /api/reservations/:id/checkout; the client never builds payment URLs itself.
4. The reserve screen may preview the card amount locally, but the charged
   amount is always derived by the server from the reservation and the
   validated points.

## Background work (E06)

1. A request does only what the user must wait for (e.g. the reservation hold,
   the Checkout URL). Slow or failure-prone side effects (mail, documents,
   calls whose result the user does not need right away) run as background
   jobs, so an outage of that dependency never fails the request.
2. Background jobs live in a job table in our own SQLite database (the
   project's queue). A job row carries: id, task, input, visibleAt (hidden
   until then), totalTried, completedAt (set = ack), hasError (set = dead
   letter), createdAt.
3. A worker claims a job by moving visibleAt into the future in a write
   transaction, does the work, and acks (completedAt) only AFTER the work
   succeeded. Delivery is therefore at-least-once: every handler must be
   safe to run twice.
4. Failed jobs are retried with exponential backoff
   (min(300 s, 2^totalTried * 5 s)). After 5 attempts the job is marked
   hasError (dead letter queue) and left for a human; it must never block
   other jobs. A handler that hits an irreversible error (a refusal no retry
   can fix) throws PermanentJobError and the job is dead-lettered at once.
5. Exactly-once effects are built, not chosen: at-least-once delivery plus an
   inbox (a table keyed by the message/event id, unique constraint) written in
   the same transaction as the effect. A duplicate insert means "already
   done": skip and ack.

## External systems (E07)

1. A database transaction covers only our database. Never call an external
   system (Stripe, Voucherify, Resend, mail) inside a transaction: a rollback
   cannot undo it.
2. Writing to our database and to an external system is a dual write. When an
   external effect must follow a database change and the user is not waiting
   for its result, record it as an outbox job (the job table above) in the
   SAME transaction as the data change; a worker delivers it at-least-once.
3. Every write call to an external service passes an idempotency key derived
   from our own ids, identical on every retry of the same operation: Stripe
   uses idempotencyKey, Resend uses idempotencyKey. Voucherify has no
   idempotency key: its sourceId is a correlation id derived the same way,
   and retries are made safe by rule 4a.
4. For providers without idempotency keys (e.g. plain SMTP) duplicates cannot
   be excluded: choose at-least-once consciously and only where a duplicate is
   cheaper than a loss.
4a. If the provider lets us look up a write by our own correlation id
   (Voucherify: card transactions by id or by the reason we sent), record
   the operation locally
   before the call and, after an uncertain response, look it up before
   re-sending (reconcile-before-retry). This is check-then-act, not true
   idempotency: a write that becomes visible only after the lookup can still
   be applied twice.
5. Incoming webhooks use an inbox: the Stripe event id is inserted into
   `stripe_events` in the same transaction as the effect it causes; a
   duplicate delivery changes nothing and still answers 2xx. Stripe retries
   for up to 3 days, so inbox rows are kept for at least 7 days and only
   older rows may be pruned.
6. Points credits/restores and ticket emails are outbox jobs. A Voucherify or
   Resend outage must never fail ticket issuance or a card-only checkout.
7. The Voucherify Sandbox budget (100 calls/hour) is a hard constraint:
   cache balances, coalesce reads, use one mutation per operation, and back
   off on 429/5xx instead of hammering the service.
8. The Voucherify balance is the only points authority. Our
   pointsUsed/pointsEarned snapshots and loyalty_operations rows exist for
   consistency, audit and retries; they never override the Voucherify balance.

# Risks / threat list

Stripe, Voucherify and Resend are external dependencies and MUST stay on this
list.

- Stripe is an external service: API outages, latency, rate limits, and webhook delays/duplicates/out-of-order delivery are expected. Checkout may return 503 PAYMENT_UNAVAILABLE; the webhook, never the browser redirect, is authoritative.
- Voucherify is an external service: API outages, latency, asynchronous balance changes, 429s and the Sandbox limit of 100 calls/hour are expected. Checkout with points may return 503 LOYALTY_UNAVAILABLE; card-only checkout and ticket issuance MUST keep working.
- Resend is an external service: outages and 403s are expected. Without a verified domain it sends from onboarding@resend.dev only to the account owner and Resend test addresses (delivered@resend.dev, bounced@resend.dev, delivered+label@resend.dev). The ticket MUST remain available on the ticket page even when the email cannot be sent.
- Secret leakage: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, VOUCHERIFY_APP_ID, VOUCHERIFY_SECRET_KEY, VOUCHERIFY_LOYALTY_PROGRAM_ID, VOUCHERIFY_LOYALTY_CARD_DEFINITION_ID and RESEND_API_KEY are server-only. Never prefix them with NEXT_PUBLIC_, never log them, never commit them. Use Stripe test keys, a Voucherify Sandbox project and Resend test mode; no live keys.
- Points tampering / double spend: the client sends only an integer points value; the server validates it against floor(amount/2) and the live Voucherify balance, and debits it before creating the reduced Stripe session. A second attempt cannot spend the same points twice.
- Points lost when a checkout fails: every debit is restored by an idempotent "restore-points" outbox job when the session expires/fails, the hold expires, or a late/double payment is refunded. A restore that exhausts its retries is dead-lettered for manual repair.
- Voucherify processes balance changes asynchronously (Loyalty v2: PENDING → APPROVED/REJECTED): an accepted debit can still be REJECTED, so checkout hands out the Stripe URL only for an APPROVED debit and treats one still PENDING after about 3 s as uncertain (503, compensated). When a response is lost, an uncertain debit may appear after a first "not found" lookup; operations are declared not applied only after the 60 s settle window, so a late debit is still restored. A debit that appears even later is not restored automatically; compare the card's transactions in the Loyalty hub with loyalty_operations.
- Welcome points: Loyalty v2 has no starting balance, so the app credits 1000 points once per email when it enrolls the member (outbox job, one operation id per email). Members enrolled outside the app get no welcome credit; a welcome credit refused for good is dead-lettered for human review.
- Transaction lookup window: transaction status is read from the card's newest 100 transactions. A very active card could push our transaction out of that window; it is then treated as not found.
- Abandoned Checkout Session paid anyway: every session abandoned by the checkout saga (failed debit, failed payment row, crash, legacy purchase) is expired through the "expire-checkout-session" outbox job, and a paid event for such an attempt is refunded instead of issuing a ticket.
- Points credited twice: Voucherify does not deduplicate balance changes (no idempotency key; the reason is not unique). Every mutation has a loyalty_operations record, a sourceId (sent as the reason) and, once accepted, the transaction id: a "done" operation is never re-sent, a known transaction is looked up instead of re-sent, and an operation whose response was lost is re-sent only after a lookup of its reason on the card finds nothing after the settle window. A change that appears even later than that is applied twice; compare the card's transactions (reason) with loyalty_operations to detect it.
- Points credit dead letter: if the "credit-points" job exhausts its retries, the reservation still reports pointsEarned but the Voucherify balance is short; the dead-letter row is the human review record.
- Points/email privacy: GET /api/loyalty returns a balance for the supplied email. Keep it rate-limited, normalize emails, and do not log emails or balances.
- Email content injection: escape reservation fields in the email HTML; never build links from user input.
- Voucherify rate-limit exhaustion: retries can consume the 100 calls/hour Sandbox budget; use caching/backoff and dead-letter rather than hammering the service.
- Price/amount tampering: price and amount come from the database; the client never sends money fields. The webhook validates currency and amount_total against the stored payment amount (reservation.amount - pointsUsed).
- Webhook forgery/replay: verify Stripe-Signature on the raw body, reject invalid signatures, and deduplicate event ids.
- Race between hold expiry and payment completion: use transactions and conditional updates. The partial unique index must prevent double-selling a seat.
- Double payment / retries: one reservation may have several Checkout Session attempts, but only one paid transition and one ticket code. A second paid attempt is refunded automatically and its points are restored.
- Late payment: a hold can expire while the customer is still on Stripe's page (sessions outlive the hold). The payment is recorded, the reservation stays expired, and the payment is refunded and its points restored through the outbox.
- User closes the browser before returning: the webhook still completes the payment, and the ticket must remain recoverable by reservation id/code.
- SQLite single-writer contention: keep payment/transaction work short and take the write lock before decision reads.
- Account/process risk: each team uses its own Stripe test account, Voucherify Sandbox project and Resend account, adds the teacher as a read-only team member to Stripe, and never uses live keys.
- Client network failures: retry safe reads and idempotent writes only; do not blindly retry a payment confirmation.
- Open redirect/phishing: redirect only to Stripe URLs returned by our own checkout endpoint; build return URLs server-side from APP_URL.
- Dual write: a crash between our commit and an external call (or vice versa) leaves the two systems disagreeing. Use the outbox, idempotency keys, and the inbox as described under External systems.
- Poison messages: a job or event that always fails must not be retried forever; cap attempts and move it to the dead letter queue for human review.

# !! WARNING

Before changing anything related to: Contract (adding, removing, changing
endpoints, response fields or persistence rules), Techstack (adding, removing
or changing dependency solutions) or the loyalty/payment rules, ask the user
for permission, then make appropriate changes in "AGENTS.md".
