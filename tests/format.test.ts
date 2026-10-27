import { describe, expect, test } from "bun:test";
import {
  formatEventDate,
  formatEventDateShort,
  formatRetryAfter,
} from "@/lib/format";

describe("format helpers", () => {
  test("formats an event date in Polish", () => {
    const formatted = formatEventDate("2026-11-05T19:00:00+01:00");

    expect(formatted).toContain("5 listopada 2026");
    expect(formatted).toContain("19:00");
  });

  test("formats a short event date", () => {
    const formatted = formatEventDateShort("2026-11-05T19:00:00+01:00");

    expect(formatted).toContain("19:00");
    expect(formatted.length).toBeLessThan(
      formatEventDate("2026-11-05T19:00:00+01:00").length,
    );
  });

  test("formats retry-after seconds", () => {
    expect(formatRetryAfter(42)).toBe("spróbuj ponownie za 42 s");
    expect(formatRetryAfter(0.4)).toBe("spróbuj ponownie za 1 s");
    expect(formatRetryAfter(9999)).toBe("spróbuj ponownie za 3600 s");
  });

  test("falls back for unusable retry-after values", () => {
    expect(formatRetryAfter(Number.NaN)).not.toContain("NaN");
    expect(formatRetryAfter(Number.POSITIVE_INFINITY)).not.toContain(
      "Infinity",
    );
    expect(formatRetryAfter(0)).toBe("spróbuj ponownie za chwilę");
  });

  test("falls back for invalid dates", () => {
    expect(formatEventDate("not-a-date")).toBe("Termin wkrótce");
  });
});
