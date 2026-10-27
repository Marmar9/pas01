import { describe, expect, test } from "bun:test";
import { eventTheme } from "@/lib/event-theme";

describe("event theme", () => {
  test("is deterministic for the same id", () => {
    expect(eventTheme("event-dune")).toEqual(eventTheme("event-dune"));
  });

  test("exposes usable colors", () => {
    const theme = eventTheme("event-interstellar");

    expect(theme.from).toMatch(/^#[0-9A-F]{6}$/i);
    expect(theme.to).toMatch(/^#[0-9A-F]{6}$/i);
    expect(theme.accent).toMatch(/^#[0-9A-F]{6}$/i);
    expect(theme.label.length).toBeGreaterThan(0);
  });

  test("spreads ids across palettes", () => {
    const labels = new Set(
      [
        "event-dune",
        "event-interstellar",
        "event-grand-budapest",
        "x",
        "y",
      ].map((id) => eventTheme(id).label),
    );

    expect(labels.size).toBeGreaterThan(1);
  });
});
