<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project overview

Purpose: Cinema ticket reservation software ("Kino" variant of the PAS S01
project). This file is the single source of truth for etap I and etap II
requirements; the original assignment documents are not kept in the repo.

Etap II goal (CEO request): customers pay online by card via Stripe instead of
paying at the entrance.
  1. The customer reserves a seat as in etap I and sees the price.
  2. Clicking "Zapłać" takes them to the Stripe Checkout page.
  3. After paying they return to the shop and see the ticket with its code.
  4. If they interrupt the payment, they return to the shop and may try again
     while the reservation is still valid.
Everything that worked in etap I MUST keep working.

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

POST /api/reservations
  headers: Idempotency-Key: <8-128 printable chars>
  body: { eventId, seatId, customerName, email }
  → 201 { reservationId, amount, expiresAt }
  amount: event.price copied when the hold is created; it never changes
  afterwards, even if the event price is edited.

GET  /api/reservations/:id
  → 200 { status, amount, expiresAt, code? }
  status: "held" | "paid" | "expired"
  code is present only when status is "paid".
  Reading a hold whose expiresAt has passed may persist the transition to
  "expired".

POST /api/reservations/:id/checkout
  Creates a Stripe Checkout Session for the reservation amount.
  → 200 { url } (Stripe Checkout page)
  Refusals:
    404 RESERVATION_NOT_FOUND
    409 RESERVATION_ALREADY_PAID
    410 RESERVATION_EXPIRED
    503 PAYMENT_UNAVAILABLE (Stripe is not configured or temporarily unavailable)
  The amount is always read from the reservation; the client never supplies it.
  Checkout is idempotent per reservation while a usable session exists:
  repeated calls SHOULD return the existing open session URL instead of
  creating another charge attempt.

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
  new payment UI.

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
  - unit_amount: reservation.amount (the captured snapshot); currency: "pln"
  - customer_email: reservation email
  - client_reference_id: reservation id
  - metadata.reservationId: reservation id
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
    stripePaymentIntentId, checkoutUrl, amount (copy of reservation.amount),
    currency, status ("pending" | "paid" | "failed" | "expired" |
    "refunded"), stripeRefundId, createdAt, updatedAt.
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
    the stored reservation/payment amount.
  - In one transaction: mark the payment paid, mark the reservation paid, and
    issue the ticket code exactly once. If the reservation is already paid,
    acknowledge the event without issuing a second code.
  - Never mark a reservation paid from an unverified or amount-mismatched event.
  - Log unknown reservation ids and amount mismatches; do not retry permanent
    failures forever (acknowledge them with 2xx so Stripe stops retrying).
  - payment_status other than "paid" (async methods) is acknowledged without
    changes; checkout.session.async_payment_succeeded completes it later.
  - A payment that arrives after the hold expired is recorded as paid for
    reconciliation, but the reservation stays expired and gets no code. In
    the same transaction a refund job is enqueued (outbox), so the customer
    is refunded automatically.
  - A second paid session for a reservation that is already paid (double
    charge) keeps the first ticket and enqueues a refund job for the second
    payment in the same transaction. The same session reported twice (e.g.
    completed + async_payment_succeeded) is not a double charge.

Refunds (background job "refund-payment"):
  - Job id: refund:${paymentId}; input: { paymentId }. Enqueueing the same
    payment twice keeps one job.
  - The worker calls stripe.refunds.create({ payment_intent, amount }) with
    idempotencyKey = the job id, outside any database transaction, then marks
    the payment "refunded" with its stripeRefundId and acks the job.
  - A payment that is already "refunded" is acked without calling Stripe.
    Stripe errors or missing Stripe configuration leave the job for a retry
    (backoff, max 5 attempts, then dead letter).

Other handled webhook events:
  - checkout.session.expired → payment "expired"
  - checkout.session.async_payment_failed → payment "failed"
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

# WEB INTERFACE

/                          event list; show price per seat
/events/:id                event by id; show price
/reserve?eventId=…&seatId=…  reservation form; show event.price, then the
                           amount returned by POST /api/reservations, and a
                           button "Zapłać <amount>"
/reservations/:id/payment/success
                           Stripe success return. Show "Płatność w toku…",
                           poll GET /api/reservations/:id, and replace the view
                           with the ticket when status becomes "paid".
                           Never trust the query string alone.
/reservations/:id/payment/cancel
                           Stripe cancel return. Show that payment was
                           interrupted and allow another checkout attempt while
                           the reservation is still valid; show the expired
                           state after the hold lapses.
/reservations/:code        ticket page with the reservation code; the server
                           looks the code up and renders it only for a paid
                           reservation

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

## Techstack

runtime: bun
endpoints: Nextjs
db: Drizzle orm, better-sqlite3 driver
libraries: nanoid (reservation codes), object-hash (idempotency fingerprints),
@universal-rate-limit/nextjs (sliding-window IP rate limiting),
stripe (official Stripe Node SDK, server-side only)
dev tools: Stripe CLI (local webhook forwarding; not an app dependency)
background jobs: `jobs` table in the app's SQLite database; the worker polls
it every 5 s from src/instrumentation.ts inside the Next.js server process
(not during `next build`), so no separate process or queue service is needed.

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
4. Payment state changes are written in a transaction and guarded by conditional updates, so retries and racing requests cannot issue two codes or sell the same seat twice.
5. Webhook handlers verify the signature before any database write and deduplicate by Stripe event id.

## Web

1. Any api calls made from the web client must retry 3 times if connection is broken or response dosent arrive after timespan of 5 seconds. If endpoint call is to be idempotent idempotency key is sent inside the request.
2. GET /api/reservations/:id polling on the payment success page uses the same timeout/retry client, keeps polling until the hold expires, and renders the ticket only after status "paid".
3. Client-side redirects to Stripe use only the { url } returned by POST /api/reservations/:id/checkout; the client never builds payment URLs itself.

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
   other jobs.
5. Exactly-once effects are built, not chosen: at-least-once delivery plus an
   inbox (a table keyed by the message/event id, unique constraint) written in
   the same transaction as the effect. A duplicate insert means "already
   done": skip and ack.

## External systems (E07)

1. A database transaction covers only our database. Never call an external
   system (Stripe, mail) inside a transaction: a rollback cannot undo it.
2. Writing to our database and to an external system is a dual write. When an
   external effect must follow a database change and the user is not waiting
   for its result, record it as an outbox job (the job table above) in the
   SAME transaction as the data change; a worker delivers it at-least-once.
3. Every write call to Stripe passes an idempotencyKey derived from our own
   ids (e.g. the reservation/payment/job id), identical on every retry of the
   same operation, so a retried call returns the original result instead of
   creating a second object.
4. For providers without idempotency keys (e.g. plain SMTP) duplicates cannot
   be excluded: choose at-least-once consciously and only where a duplicate is
   cheaper than a loss.
5. Incoming webhooks use an inbox: the Stripe event id is inserted into
   `stripe_events` in the same transaction as the effect it causes; a
   duplicate delivery changes nothing and still answers 2xx. Stripe retries
   for up to 3 days, so inbox rows are kept for at least 7 days and only
   older rows may be pruned.

# Risks / threat list

Stripe is an external dependency and MUST stay on this list.

- Stripe is an external service: API outages, latency, rate limits, and webhook delays/duplicates/out-of-order delivery are expected. Checkout may return 503 PAYMENT_UNAVAILABLE; the webhook, never the browser redirect, is authoritative.
- Secret leakage: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are server-only. Never prefix them with NEXT_PUBLIC_, never log them, never commit them. Test keys only (sk_test_…), no live mode.
- Webhook forgery/replay: verify Stripe-Signature on the raw body, reject invalid signatures, and deduplicate event ids.
- Price/amount tampering: price and amount come from the database; the client never sends money fields. The webhook validates currency and amount_total against the stored amount.
- Race between hold expiry and payment completion: use transactions and conditional updates. The partial unique index must prevent double-selling a seat.
- Double payment / retries: one reservation may have several Checkout Session attempts, but only one paid transition and one ticket code. A second paid attempt is refunded automatically.
- Late payment: a hold can expire while the customer is still on Stripe's page (sessions outlive the hold). The payment is recorded, the reservation stays expired, and the payment is refunded through the outbox.
- User closes the browser before returning: the webhook still completes the payment, and the ticket must remain recoverable by reservation id/code.
- SQLite single-writer contention: keep payment/transaction work short and take the write lock before decision reads.
- Account/process risk: each team uses its own Stripe test account, adds the teacher as a read-only team member, and never uses live keys.
- Client network failures: retry safe reads and idempotent writes only; do not blindly retry a payment confirmation.
- Open redirect/phishing: redirect only to Stripe URLs returned by our own checkout endpoint; build return URLs server-side from APP_URL.
- Dual write: a crash between our commit and an external call (or vice versa) leaves the two systems disagreeing. Use the outbox, idempotency keys, and the inbox as described under External systems.
- Poison messages: a job or event that always fails must not be retried forever; cap attempts and move it to the dead letter queue for human review.

# !! WARNING

Before changing anything related to: Contract (adding, removing endpoits ect.) and Techstack (adding, removing, chaneging dependency solutions), ask user for permission, then make apropriate changes in "AGENTS.md" file.
