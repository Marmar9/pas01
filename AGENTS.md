<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project overview

Purpose: Cinema ticket reservation software

## Contract

# API

GET  /api/events           → { events: [...] }
GET  /api/events/:id       → { event, takenSeats: ["A2", "B1"] }
POST /api/reservations     headers: Idempotency-Key: <8-128 printable chars>
                           { eventId, seatId, customerName, email }
                           → { reservationId, code }
Repeated POST with the same Idempotency-Key and payload replays the original
response (header Idempotency-Replayed: true); a different payload under the same
key → 409 IDEMPOTENCY_KEY_REUSED.
All endpoints: 429 RATE_LIMITED with Retry-After when the sliding-window IP limit
is exceeded, 500 INTERNAL_ERROR on unexpected failures.
Errors → { error, code, details? }

# WEB INTERFACE

/                          event list
/events/:id                event by id
/reserve?eventId=…&seatId=…  reservation form
/reservations/:code        redirect page with reservation code

## Techstack

runtime: bun
endpoints: Nextjs
db: Drizzle orm, better-sqlite3 driver

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
3. Api endpoits are protected by sliding window rate limiting by ip.

## Web

1. Any api calls made from the web client must retry 3 times if connection is broken or response dosent arrive after timespan of 5 seconds. If endpoint call is to be idempotent idempotency key is sent inside the request.

# !! WARNING

Before changing anything related to: Contract (adding, removing endpoits ect.) and Techstack (adding, removing, chaneging dependency solutions), ask user for permission, then make apropriate changes in "AGENTS.md" file.
