# Technikino — frontend design

Date: 2026-10-27
Branch: `feat/frontend` (from `origin/feat/backend`)
Status: awaiting approval

## Goal

A Polish-language cinema ticketing frontend for the existing backend API, branded
**Technikino** and visually modelled on technischools.com. No backend, contract, or
techstack changes.

## Visual language (from technischools.com)

- Roboto via `next/font/google`; body `gray-600` on light sections.
- Indigo `#3813C2` (primary), magenta `#E50F88` (secondary), near-black `#0B0713` (ink).
- Full-bleed dark hero: layered black gradients, blurred indigo/magenta glow blobs,
  huge uppercase white display type, white/95 pill badges.
- Magenta gradient `rounded-2xl` CTA with arrow icon; pulsing-dot microcopy.
- Fixed header, transparent over the hero, solid blurred ink after ~40px scroll.
- Container `mx-auto px-4 lg:px-12`; `rounded-2xl` cards, soft shadows, lift on hover.
- Light content sections between dark hero and dark footer.
- No remote images: per-event "poster" art is a deterministic CSS gradient + oversized
  typography, so the app works offline and needs no new dependencies.
- Motion respects `prefers-reduced-motion`; all interactive elements keyboard reachable
  with visible focus rings.

## Pages

### `/` — event list

1. Hero (dark): badge „Kino przyszłości", wordmark **TECHNIKINO**, subtitle, primary CTA
   „Zarezerwuj miejsce" (scrolls to repertuar), ghost CTA „Zobacz repertuar", pulsing-dot
   microcopy, stat strip (liczba filmów, sale, miejsc — derived from loaded events).
2. „Repertuar" (light): eyebrow + „Wybierz swój seans", responsive grid of event cards.
   Card: gradient poster, title, date (`pl-PL`), venue pill, free-seat count, CTA
   „Wybierz miejsce" → `/events/:id`.
3. „Jak to działa": three numbered steps (seans → miejsce → kod).
4. Dark feature panel with glow: bezpieczna rezerwacja, natychmiastowy kod, zero kolejek.
5. Dark footer: wordmark, anchors, copyright, „inspirowane Technischools".

### `/events/:id` — event + seat picker

- Breadcrumb, poster art, title, description, date/venue/hall meta, free-seat badge.
- Dark seat-map panel: „EKRAN" bar, rows A… labelled, seats as buttons.
  States: free, taken (disabled), selected (gradient + ring); legend; horizontally
  scrollable on small screens; seats labelled for screen readers („Miejsce A2, zajęte").
- Sticky summary: selected seat + „Dalej" → `/reserve?eventId=…&seatId=…`.
- Loading skeleton, not-found state, retryable error state.

### `/reserve?eventId=…&seatId=…` — reservation form

- Validates both params; invalid → error card with link to repertuar.
- Re-fetches the event to show a summary card and confirm the seat is still free.
- Fields: imię i nazwisko, adres e-mail; inline messages from `details`.
- One idempotency key per form mount (UUID), stable across retries.
- Submit: disabled + spinner while pending. Error handling:
  `SEAT_TAKEN` → inline notice + link to event; `RATE_LIMITED` → countdown from
  `Retry-After`; `VALIDATION_ERROR` → per-field; anything else → generic banner.
- Success → `/reservations/:code?eventId=…&seatId=…`.

### `/reservations/:code` — confirmation

- Dark confirmation card with glow and check mark, „Rezerwacja potwierdzona".
- Code in large mono type with copy button („Skopiowano").
- If `eventId`/`seatId` query params are present, shows film, date, venue and seat;
  otherwise only the code.
- Links back to repertuar.

## Client data layer

`src/lib/client-api.ts` — the only place that talks to the API:

- 5 s `AbortController` timeout per attempt.
- Retries 3 additional times (4 attempts total) on network failure or timeout, with
  300/600/1200 ms backoff; 4xx/5xx are surfaced immediately.
- `ApiError` carries `status`, `code`, `details`, `retryAfter`.
- `getEvents()`, `getEvent(id)`, `createReservation(input, idempotencyKey)`.
- POST always sends `Idempotency-Key`; the same key is reused across retries.

## Structure

```
src/app/layout.tsx                 Roboto, pl metadata, header/footer
src/app/globals.css                @theme tokens, glow/gradient utilities
src/app/page.tsx                   home composition
src/app/events/[id]/page.tsx       + event-detail-client.tsx
src/app/reserve/page.tsx           + reserve-form.tsx
src/app/reservations/[code]/page.tsx + confirmation-client.tsx
src/components/site-header.tsx
src/components/site-footer.tsx
src/components/hero.tsx
src/components/event-card.tsx
src/components/event-grid.tsx
src/components/seat-map.tsx
src/components/glow.tsx
src/lib/client-api.ts
src/lib/format.ts
src/lib/event-theme.ts
src/lib/seats.ts
```

Home and page shells are server components; data fetching, seat picking and the form are
client components. All data goes through the public API (no direct DB reads from pages).

## Dependencies

None added. Roboto comes from `next/font/google`; icons are inline SVG.

## Verification

- `bun run lint` clean on every changed file.
- `bun test` for `client-api` retry/idempotency and seat helpers.
- `bun run build` succeeds.
- Manual smoke with `bun run dev`: list → event → seat → reserve → confirmation,
  including a taken-seat conflict and a forced retry.

## Commits

Conventional commits on `feat/frontend`, e.g.
`feat(web): add technikino design tokens and layout`,
`feat(web): add event list and seat picker`,
`feat(web): add reservation form and confirmation`.
