import { createDb } from "./client";
import { events } from "./schema";

const seedEvents = [
  {
    id: "6f0f0f7c-1e5a-4a7e-9d5b-2b8a0c4e1f01",
    title: "Dune: Part Three",
    description:
      "Paul Atreides unites with the Fremen while facing the consequences of his rise to power.",
    venue: "Hall 1",
    startsAt: new Date("2026-11-05T19:00:00+01:00"),
    rows: 10,
    seatsPerRow: 14,
  },
  {
    id: "6f0f0f7c-1e5a-4a7e-9d5b-2b8a0c4e1f02",
    title: "Interstellar",
    description:
      "A team of explorers travels through a wormhole in search of a new home for humanity.",
    venue: "Hall 2",
    startsAt: new Date("2026-11-06T17:30:00+01:00"),
    rows: 8,
    seatsPerRow: 12,
  },
  {
    id: "6f0f0f7c-1e5a-4a7e-9d5b-2b8a0c4e1f03",
    title: "The Grand Budapest Hotel",
    description:
      "A legendary concierge and his lobby boy become entangled in a tale of theft and intrigue.",
    venue: "Hall 3",
    startsAt: new Date("2026-11-07T20:15:00+01:00"),
    rows: 6,
    seatsPerRow: 10,
  },
];

const db = createDb();

for (const event of seedEvents) {
  db.insert(events).values(event).onConflictDoNothing().run();
}

console.log(`Seeded ${seedEvents.length} events.`);
