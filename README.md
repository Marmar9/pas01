# Cinema ticket reservation project

Cinema ticket reservation app built with Next.js, Drizzle ORM and SQLite
(`better-sqlite3`), with Stripe Checkout (test mode) for payments.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Node.js 20+ (Next.js server runtime)
- [Stripe CLI](https://stripe.com/docs/stripe-cli) for local webhook forwarding
  (development only, not an app dependency)

## Setup

```bash
bun install
cp .env.example .env.local   # then fill in your Stripe test keys
bun run db:migrate
bun run db:seed
bun run dev
```

The SQLite database lives in `data/cinema.db` (gitignored). Override the
location with the `DATABASE_PATH` environment variable.

## Environment variables

All of these are **server-side only**. Never prefix them with `NEXT_PUBLIC_`
and never commit real values.

| Variable                | Required | Description                                              |
| ----------------------- | -------- | -------------------------------------------------------- |
| `DATABASE_PATH`         | no       | SQLite file path (default `data/cinema.db`)              |
| `STRIPE_SECRET_KEY`     | yes      | Stripe test secret key (`sk_test_…`)                     |
| `STRIPE_WEBHOOK_SECRET` | yes      | Webhook signing secret (`whsec_…`)                       |
| `APP_URL`               | no       | Origin for Stripe return URLs (default `http://localhost:3000`) |

The app refuses a `STRIPE_SECRET_KEY` that does not start with `sk_test_`, so
live mode cannot be enabled by accident. Without Stripe configuration, checkout
returns `503 PAYMENT_UNAVAILABLE` and the webhook endpoint returns
`503 PAYMENT_UNAVAILABLE`.

## Local Stripe webhooks

Stripe must be able to reach the webhook endpoint. The quickest way is
`bun run dev:stripe`, which starts the dev server and `stripe listen` together
(the CLI authenticates with `STRIPE_SECRET_KEY` from `.env.local`, so
`stripe login` is not needed). To run them separately, in a second terminal:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the printed `whsec_…` value into `STRIPE_WEBHOOK_SECRET` in `.env.local`
and restart the dev server. On a deployed environment, add
`/api/webhooks/stripe` as a **test-mode** endpoint in the Stripe Dashboard and
store its signing secret in the server environment.

Without the Stripe CLI you can still create a Checkout Session, but the
reservation will stay `held` until the `checkout.session.completed` webhook is
delivered. Landing on the success page is not proof of payment.

### Test cards

| Card number          | Result      |
| -------------------- | ----------- |
| `4242 4242 4242 4242`| success     |
| `4000 0000 0000 0002`| declined    |
| `4000 0025 0000 3155`| 3D Secure   |

Use any future expiry date and any 3-digit CVC.

## Scripts

| Script               | Description                                  |
| -------------------- | -------------------------------------------- |
| `bun run dev`        | Start the Next.js dev server                 |
| `bun run dev:stripe` | Dev server + Stripe webhook forwarding together (needs `STRIPE_SECRET_KEY` in `.env.local`) |
| `bun run stripe:listen` | Only the Stripe CLI webhook forwarding    |
| `bun run build`      | Production build                             |
| `bun run start`      | Start the production server                  |
| `bun run lint`       | Biome check                                  |
| `bun run test`       | Run tests with `bun test`                    |
| `bun run db:generate`| Generate a migration from the Drizzle schema |
| `bun run db:migrate` | Apply pending migrations                     |
| `bun run db:seed`    | Insert sample events (idempotent)            |
| `bun run db:studio`  | Open Drizzle Studio                          |

## API

| Method | Route                                    | Description                                      |
| ------ | ---------------------------------------- | ------------------------------------------------ |
| `GET`  | `/api/events`                            | `{ events: Event[] }`                            |
| `GET`  | `/api/events/:id`                        | `{ event, takenSeats: string[] }`                |
| `POST` | `/api/reservations`                      | `Idempotency-Key` + `{ eventId, seatId, customerName, email }` → `{ reservationId, amount, expiresAt }` |
| `GET`  | `/api/reservations/:id`                  | `{ status, amount, expiresAt, code? }`           |
| `POST` | `/api/reservations/:id/checkout`         | `{ url }` — Stripe Checkout page                 |
| `POST` | `/api/webhooks/stripe`                   | Stripe webhook receiver (signature verified)     |
| `POST` | `/api/reservations/:id/purchase`         | **Deprecated** legacy `{ code }` endpoint        |

`Event` shape:
`{ id, title, description, venue, startsAt, rows, seatsPerRow, price }`.

All prices and amounts are integer grosze (`3200` = 32 zł). A reservation copies
the event price into `amount` when the hold is created; editing the event later
does not change an existing hold.

Seats are `<row letter><number>`, e.g. `A2`, and must fit the event's
`rows × seatsPerRow` layout.

`POST /api/reservations` requires an `Idempotency-Key` header (8–128 printable
ASCII characters). It creates a hold and returns
`{ reservationId, amount, expiresAt }` (ISO-8601 UTC). Holds last 15 minutes
when `NODE_ENV=production` and 2 minutes otherwise (development/test). Repeating
a request with the same key and payload replays the original response with
`Idempotency-Replayed: true`; reusing a key with a different payload returns
`409 IDEMPOTENCY_KEY_REUSED`.

### Payment flow

1. `POST /api/reservations` creates a `held` reservation.
2. `POST /api/reservations/:id/checkout` creates a Stripe Checkout Session for
   the stored `amount` and returns `{ url }`. While a pending session exists for
   the reservation, repeated calls reuse that session instead of creating
   another charge attempt.
3. The browser is redirected only to the `url` returned by our own checkout
   endpoint. Stripe returns the user to
   `/reservations/:id/payment/success?session_id=…` or
   `/reservations/:id/payment/cancel`.
4. Stripe delivers `checkout.session.completed` to
   `/api/webhooks/stripe`. The handler verifies `Stripe-Signature` against the
   raw body, checks `payment_status=paid`, currency `pln` and `amount_total`
   against the stored amount, then atomically marks the payment and reservation
   paid and issues the ticket code once.
5. The success page polls `GET /api/reservations/:id` and shows the ticket only
   after `status` is `paid`. The cancel page allows another checkout attempt
   while the hold is still valid.

A reservation is `held` until the webhook marks it `paid`, or until
`expiresAt` passes (or a checkout is attempted after expiry), which makes it
`expired`. An expired hold frees its seat for a new reservation.

`POST /api/reservations/:id/purchase` is kept only for backward compatibility.
New flows must use the checkout endpoint. Its responses include
`Deprecation: true`.

### Errors

Errors are returned as `{ error, code, details? }`:

- `400 VALIDATION_ERROR`
- `400 INVALID_SIGNATURE` (webhook only)
- `404 EVENT_NOT_FOUND` / `RESERVATION_NOT_FOUND`
- `409 SEAT_TAKEN` / `IDEMPOTENCY_KEY_REUSED` / `RESERVATION_ALREADY_PAID`
- `410 RESERVATION_EXPIRED`
- `429 RATE_LIMITED` (sliding-window IP limit, includes `Retry-After`)
- `500 INTERNAL_ERROR`
- `503 PAYMENT_UNAVAILABLE`

Rate limits are in-memory and per process: 120 requests/min for event reads, 20
requests/min for reservation creation, 20 requests/min for purchases and
checkouts, with a much higher dedicated allowance for the Stripe webhook so
legitimate Stripe bursts are not dropped. They are enforced by
`universal-rate-limit` with a sliding-window algorithm and an in-memory store.

### Payment data

Every Checkout Session attempt is recorded in the `payments` table with the
Stripe session id, payment intent id, captured amount, currency and status
(`pending`, `paid`, `failed`, `expired`). Processed webhook event ids are stored
in `stripe_events` with a unique constraint, so duplicate deliveries are
no-ops.

Reservation codes are generated with `nanoid` at payment confirmation time, and
idempotency request fingerprints use `object-hash` (SHA-256).
