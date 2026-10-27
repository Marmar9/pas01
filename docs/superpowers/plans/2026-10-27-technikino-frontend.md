# Technikino Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Polish Technikino cinema frontend on top of the existing backend API.

**Architecture:** Next.js App Router pages with server shells and client components that fetch the public API through one retrying client (`src/lib/client-api.ts`). Pure helpers (seat ids, date formatting, poster themes) are unit tested with `bun test`; UI is verified with `bun run lint` and `bun run build`.

**Tech Stack:** Next 16.4.3, React 19.3, Tailwind v4, `next/font/google` Roboto, bun test, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-technikino-frontend-design.md`

## Global Constraints

- Polish UI copy; brand name **TECHNIKINO**; tagline „Kino przyszłości".
- Colors: primary `#3813C2`, secondary `#E50F88`, ink `#0B0713`.
- No new npm dependencies; icons are inline SVG; no remote images.
- API base is same-origin `/api/*`; never read the DB from pages.
- Client API: 5 s timeout per attempt, 3 retries on network failure/timeout only, 300/600/1200 ms backoff, same `Idempotency-Key` across retries.
- Every route in the contract exists: `/`, `/events/:id`, `/reserve`, `/reservations/:code`.
- `bun run lint` must pass on changed files; commits are conventional; branch is `feat/frontend`.
- Accessibility: seats are real buttons with Polish `aria-label`s, visible `focus-visible` rings, `prefers-reduced-motion` respected.

## Review Focus

- **Malformed or non-JSON API response** → must surface a readable `INVALID_RESPONSE` error, never crash the page.
- **Double submit / rapid clicks on the reservation form** → one POST per idempotency key, button disabled while pending.
- **`429` without a usable `Retry-After`** → show a sensible Polish message instead of `NaN`.
- **Missing/invalid `eventId`/`seatId` query params** → friendly error card with a link back, no request sent.
- **Seat taken between page load and submit (`409 SEAT_TAKEN`)** → inline notice and a link back to the seat map; no generic crash.

---

### Task 1: Design foundation, layout, header, footer

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx`
- Create: `src/components/site-header.tsx`
- Create: `src/components/site-footer.tsx`
- Create: `src/components/wordmark.tsx`

**Interfaces:**
- Produces: `SiteHeader()` client component; `SiteFooter()` server component; `Wordmark({ className?: string })`.
- Produces CSS tokens usable as `bg-primary`, `text-secondary`, `bg-ink`, `font-sans`.

- [ ] **Step 1:** Replace `globals.css` with Tailwind import, `@theme inline` tokens (`--color-primary`, `--color-primary-dark`, `--color-secondary`, `--color-ink`, `--color-ink-soft`, `--font-sans: var(--font-roboto)`), and `@layer components` utilities `.container-page` (`mx-auto w-full max-w-7xl px-4 lg:px-12`), `.text-gradient`, `.glow-blob`, `.surface-card`, `.focus-ring`.
- [ ] **Step 2:** In `layout.tsx`, load `Roboto` with `subsets: ["latin", "latin-ext"]`, weights `400/500/700/900`, `variable: "--font-roboto"`; set `lang="pl"`, Polish `metadata` (`title: "Technikino — kino przyszłości"`), body classes `bg-ink font-sans text-zinc-100 antialiased`, render `<SiteHeader />`, `<main>{children}</main>`, `<SiteFooter />`.
- [ ] **Step 3:** Build `SiteHeader`: fixed top, transparent initially, `bg-ink/85 backdrop-blur-xl border-b border-white/10` after 40 px scroll (passive listener, cleanup). Wordmark left, desktop nav (`Repertuar` → `/#repertuar`, `Jak to działa` → `/#jak-to-dziala`), gradient CTA „Zarezerwuj" → `/#repertuar`. Mobile: hamburger toggles a full-width panel; `aria-expanded`, `aria-label`.
- [ ] **Step 4:** Build `SiteFooter`: dark panel, wordmark, short Polish blurb, anchor list, `© 2026 Technikino`, note „Inspirowane Technischools".
- [ ] **Step 5:** Verify `bun run lint` and `bun run build`; fix issues.
- [ ] **Step 6:** Commit `feat(web): add technikino design tokens and layout`.

### Task 2: Client API and pure helpers (TDD)

**Files:**
- Create: `src/lib/client-api.ts`
- Create: `src/lib/seats.ts`
- Create: `src/lib/format.ts`
- Create: `src/lib/event-theme.ts`
- Create: `tests/seats.test.ts`
- Create: `tests/format.test.ts`
- Create: `tests/client-api.test.ts`
- Create: `tests/event-theme.test.ts`

**Interfaces:**
- `EventDto`, `EventWithTakenSeats` mirror the backend DTOs exactly.
- `class ApiError extends Error { status: number; code: ApiErrorCode; details?: Record<string,string>; retryAfter?: number }`; `ApiErrorCode` adds `NETWORK_ERROR` and `INVALID_RESPONSE` to the backend codes.
- `getEvents(): Promise<EventDto[]>`, `getEvent(id: string): Promise<EventWithTakenSeats>`, `createReservation(input: ReservationInput, idempotencyKey: string): Promise<ReservationResult>` where `ReservationInput = { eventId; seatId; customerName; email }` and `ReservationResult = { reservationId; code }`.
- `seats.ts`: `rowLabel(index: number): string`, `toSeatId(rowIndex: number, seatNumber: number): string`, `isValidSeatId(value: string): boolean` (`/^[A-Z]([1-9][0-9]?)$/`), `normalizeSeatId(value: string): string`, `buildSeatRows(rows: number, seatsPerRow: number): string[][]`, `countFreeSeats(rows, seatsPerRow, takenSeats: string[]): number`.
- `format.ts`: `formatEventDate(iso: string): string`, `formatEventDateShort(iso: string): string` (both `pl-PL`, `timeZone: "Europe/Warsaw"`), `formatRetryAfter(seconds: number): string` returning e.g. `"spróbuj ponownie za 42 s"`, clamped to 1–3600 with a fallback when not finite.
- `event-theme.ts`: `eventTheme(id: string): { from: string; to: string; accent: string; label: string }`, deterministic across calls, 3 palettes chosen by a simple string hash.

- [ ] **Step 1:** Write failing tests for seats: `rowLabel(0) === "A"`, `toSeatId(1, 12) === "B12"`, `isValidSeatId("A1")` true, `isValidSeatId("a1")`/`"A0"`/`"AA1"` false, `normalizeSeatId(" b7 ") === "B7"`, `buildSeatRows(2, 3)` equals `[["A1","A2","A3"],["B1","B2","B3"]]`, `countFreeSeats(2, 3, ["A1","B3"]) === 4`.
- [ ] **Step 2:** Write failing tests for format: `formatEventDate("2026-11-05T19:00:00+01:00")` contains `"5 listopada 2026"` and `"19:00"`; `formatRetryAfter(42) === "spróbuj ponownie za 42 s"`; `formatRetryAfter(Number.NaN)` returns the fallback without `NaN`.
- [ ] **Step 3:** Write failing tests for `client-api` by stubbing `globalThis.fetch`: retries 3 times on `TypeError` then succeeds (4 calls, same body and same `Idempotency-Key`); does not retry a `400` (1 call) and throws `ApiError` with `code: "VALIDATION_ERROR"` and `details`; non-JSON 200 throws `INVALID_RESPONSE`; `429` exposes `retryAfter: 30` from the header; network failure after all retries throws `NETWORK_ERROR`.
- [ ] **Step 4:** Run `bun test`; confirm the new tests fail for missing modules.
- [ ] **Step 5:** Implement the four helpers. In `client-api.ts`, use an internal `requestJson<T>(path, init)` with `AbortController`, `REQUEST_TIMEOUT_MS = 5000`, `MAX_RETRIES = 3`, `RETRY_DELAYS_MS = [300, 600, 1200]`; retry only `TypeError`/`AbortError` from fetch; read `Retry-After` with `Number.parseInt`.
- [ ] **Step 6:** Run `bun test`; all tests pass.
- [ ] **Step 7:** Verify `bun run lint`; commit `feat(web): add retrying api client and seat helpers`.

### Task 3: Home page

**Files:**
- Create: `src/components/hero.tsx`
- Create: `src/components/event-card.tsx`
- Create: `src/components/event-poster.tsx`
- Create: `src/components/event-grid.tsx`
- Create: `src/components/how-it-works.tsx`
- Create: `src/components/feature-band.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- `EventPoster({ event, className })` renders the deterministic gradient art with the title and a small `TECHNIKINO` label.
- `EventGrid()` fetches `getEvents()` then `getEvent()` for each event in parallel; renders skeleton cards while loading, a Polish error card with „Spróbuj ponownie" on failure, and empty state „Brak seansów w repertuarze".
- `EventCard({ event, freeSeats? })` links to `/events/${event.id}`.

- [ ] **Step 1:** Build `page.tsx` as a client composition: hero, `<EventGrid />` inside `<section id="repertuar">`, `<HowItWorks />`, `<FeatureBand />`.
- [ ] **Step 2:** Hero: full-viewport dark gradient with indigo/magenta blur blobs, pill „Kino przyszłości", `h1` TECHNIKINO in `text-[clamp(3.5rem,12vw,11rem)] font-black uppercase leading-none`, subtitle „Zarezerwuj miejsce w kilka sekund — bez kolejek i papierowych biletów.", gradient CTA „Zarezerwuj miejsce" (`#repertuar`), ghost CTA „Zobacz repertuar", pulsing-dot microcopy „Rezerwacja online w 3 krokach", stat strip (`filmy`, `sale`, `miejsc`).
- [ ] **Step 3:** `EventCard`: poster area, date badge, venue pill, title, short description (line-clamp-2), free-seat count when known, CTA „Wybierz miejsce" with arrow; hover lift and ring.
- [ ] **Step 4:** `HowItWorks` (3 numbered steps: „Wybierz seans", „Wskaż miejsce", „Odbierz kod") and `FeatureBand` (dark rounded-3xl panel: „Bezpieczna rezerwacja", „Natychmiastowy kod", „Zero kolejek").
- [ ] **Step 5:** Verify `bun run lint` + `bun run build`; load `/` in dev and confirm hero, 3 cards, steps, footer.
- [ ] **Step 6:** Commit `feat(web): add technikino home page and repertuar`.

### Task 4: Event detail and seat map

**Files:**
- Create: `src/app/events/[id]/page.tsx`
- Create: `src/app/events/[id]/event-detail.tsx`
- Create: `src/components/seat-map.tsx`
- Create: `src/components/state-card.tsx`

**Interfaces:**
- `EventDetail({ eventId })` client component fetches `getEvent(eventId)`; owns `selectedSeat: string | null`.
- `SeatMap({ event, takenSeats, selected, onSelect })`; seats are `<button type="button">` with `aria-pressed` and `aria-label` `"Miejsce A2"` / `"Miejsce A2, zajęte"`.
- `StateCard({ title, description, action? })` shared loading/error/not-found panel.

- [ ] **Step 1:** Page shell reads `params` (await in Next 16), renders `<EventDetail eventId={id} />` with a breadcrumb „Repertuar / szczegóły seansu".
- [ ] **Step 2:** `EventDetail` states: loading skeleton; `EVENT_NOT_FOUND` → „Nie znaleźliśmy tego seansu" + link; other errors → retry button; success → poster, title, description, date/venue/hall meta, free-seat badge.
- [ ] **Step 3:** `SeatMap`: „EKRAN" bar, rows labelled `A…`, seats `size-7 sm:size-8 rounded-t-md`; free `bg-white/10 hover:bg-primary`, taken `bg-zinc-800 text-zinc-600 cursor-not-allowed`, selected gradient + ring; legend; horizontal scroll wrapper on mobile.
- [ ] **Step 4:** Sticky bottom summary: „Wybrane miejsce: A2" or „Wybierz miejsce na planie", CTA „Dalej" disabled without selection → `/reserve?eventId=…&seatId=…`.
- [ ] **Step 5:** Verify lint + build; open an event, pick a seat, confirm the link target; check keyboard focus order.
- [ ] **Step 6:** Commit `feat(web): add event detail with seat picker`.

### Task 5: Reservation form

**Files:**
- Create: `src/app/reserve/page.tsx`
- Create: `src/app/reserve/reserve-form.tsx`

**Interfaces:**
- `ReserveForm({ eventId, seatId })`; validates `isValidSeatId(normalizeSeatId(seatId))`, generates one key with `crypto.randomUUID()` in a `useRef`, reuses it for every retry and re-submit.
- On success: `router.push(\`/reservations/${code}?eventId=…&seatId=…\`)`.

- [ ] **Step 1:** Page shell: `searchParams` are async in Next 16; render `<ReserveForm eventId={…} seatId={…} />`, or an error card when either param is missing.
- [ ] **Step 2:** Fetch the event for the summary (poster, title, date, venue, seat) and show „Sprawdzamy dostępność…" while loading; if the seat is already in `takenSeats`, show the conflict card instead of the form.
- [ ] **Step 3:** Form fields imię i nazwisko + e-mail with labels, `autoComplete`, required, client-side trim; disable submit while pending; show spinner text „Rezerwujemy…".
- [ ] **Step 4:** Error mapping: `VALIDATION_ERROR` → field messages from `details` (fallback banner); `SEAT_TAKEN` → „To miejsce zostało właśnie zajęte" + link to `/events/:id`; `RATE_LIMITED` → `formatRetryAfter(retryAfter)` and disable submit until it elapses; `IDEMPOTENCY_KEY_REUSED` → generate a new key and let the user retry; anything else → generic banner with retry.
- [ ] **Step 5:** Verify lint + build; submit with valid data against the dev server and land on the confirmation page.
- [ ] **Step 6:** Commit `feat(web): add reservation form with idempotent submit`.

### Task 6: Confirmation page

**Files:**
- Create: `src/app/reservations/[code]/page.tsx`
- Create: `src/app/reservations/[code]/confirmation.tsx`

**Interfaces:**
- `Confirmation({ code, eventId, seatId })`; renders the code from the URL, copy button using `navigator.clipboard.writeText` with a „Skopiowano" state and a silent fallback.

- [ ] **Step 1:** Page shell awaits `params`/`searchParams` and renders `<Confirmation />`.
- [ ] **Step 2:** Dark centered card with glow and check mark, „Rezerwacja potwierdzona", code in `font-mono text-4xl tracking-[0.2em]`, instruction „Zapisz ten kod — pokażesz go przy wejściu."
- [ ] **Step 3:** When `eventId` is present, fetch the event and show film, date, venue and seat; tolerate fetch failure by showing only the code.
- [ ] **Step 4:** Links „Wróć do repertuaru" and „Zobacz szczegóły seansu".
- [ ] **Step 5:** Verify lint + build; open a fabricated code URL and a full URL with query params.
- [ ] **Step 6:** Commit `feat(web): add reservation confirmation page`.

### Task 7: Final verification

**Files:** none new; fix anything found.

- [ ] **Step 1:** `bun test` — all tests pass.
- [ ] **Step 2:** `bun run lint` — clean.
- [ ] **Step 3:** `bun run build` — succeeds.
- [ ] **Step 4:** Smoke with `bun run dev` + `bun run db:seed`: `GET /api/events` returns 3 events; `/`, `/events/:id`, `/reserve?eventId=…&seatId=…`, `/reservations/ABC123` return 200 and Polish copy; reserve a seat via curl and confirm the taken seat disappears from `takenSeats`.
- [ ] **Step 5:** Review responsive behavior at 375 px and 1440 px and keyboard-only flow.
- [ ] **Step 6:** Commit `chore(web): polish technikino frontend after smoke test` if fixes were needed.
