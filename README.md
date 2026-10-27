# Cinema ticket reservation project

Cinema ticket reservation app built with Next.js, Drizzle ORM and SQLite
(`better-sqlite3`).

## Requirements

- [Bun](https://bun.sh) 1.4+
- Node.js 20+ (Next.js server runtime)

## Setup

```bash
bun install
bun run db:migrate
bun run db:seed
bun run dev
```

The SQLite database lives in `data/cinema.db` (gitignored). Override the
location with the `DATABASE_PATH` environment variable.

## Scripts

| Script               | Description                                  |
| -------------------- | -------------------------------------------- |
| `bun run dev`        | Start the Next.js dev server                 |
| `bun run build`      | Production build                             |
| `bun run start`      | Start the production server                  |
| `bun run lint`       | Biome check                                  |
| `bun run test`       | Run tests with `bun test`                    |
| `bun run db:generate`| Generate a migration from the Drizzle schema |
| `bun run db:migrate` | Apply pending migrations                     |
| `bun run db:seed`    | Insert sample events (idempotent)            |
| `bun run db:studio`  | Open Drizzle Studio                          |

## API

| Method | Route               | Description                                    |
| ------ | ------------------- | ---------------------------------------------- |
| `GET`  | `/api/events`       | `{ events: Event[] }`                          |
| `GET`  | `/api/events/:id`   | `{ event, takenSeats: string[] }`              |
| `POST` | `/api/reservations` | `{ eventId, seatId, customerName, email }` → `{ reservationId, code }` |

`Event` shape: `{ id, title, description, venue, startsAt, rows, seatsPerRow }`.
Seats are `<row letter><number>`, e.g. `A2`, and must fit the event's
`rows × seatsPerRow` layout.

Errors are returned as `{ error, code, details? }` with `400`
(`VALIDATION_ERROR`), `404` (`EVENT_NOT_FOUND`) or `409` (`SEAT_TAKEN`).
