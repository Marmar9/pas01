import { describe, expect, test } from "bun:test";
import {
  cardAmountFor,
  clampPoints,
  formatPoints,
  maxSpendablePoints,
} from "@/lib/loyalty-points";

describe("loyalty points helpers", () => {
  test("caps points at the balance and half the ticket", () => {
    expect(maxSpendablePoints(3200, 1000)).toBe(1000);
    expect(maxSpendablePoints(3200, 9999)).toBe(1600);
    expect(maxSpendablePoints(3201, 9999)).toBe(1600);
  });

  test("returns zero for unusable amounts or balances", () => {
    expect(maxSpendablePoints(0, 500)).toBe(0);
    expect(maxSpendablePoints(3200, -5)).toBe(0);
    expect(maxSpendablePoints(3200, 0)).toBe(0);
    expect(maxSpendablePoints(Number.NaN, 500)).toBe(0);
    expect(maxSpendablePoints(3200, Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("clamps points into the allowed range", () => {
    expect(clampPoints(1200, 1000)).toBe(1000);
    expect(clampPoints(-5, 1000)).toBe(0);
    expect(clampPoints(12.9, 1000)).toBe(12);
    expect(clampPoints(500, 1000)).toBe(500);
  });

  test("returns zero for unusable points or caps", () => {
    expect(clampPoints(Number.NaN, 1000)).toBe(0);
    expect(clampPoints(500, Number.NaN)).toBe(0);
    expect(clampPoints(500, -10)).toBe(0);
  });

  test("computes the card amount", () => {
    expect(cardAmountFor(3200, 1000)).toBe(2200);
    expect(cardAmountFor(3200, 0)).toBe(3200);
    expect(cardAmountFor(3200, 5000)).toBe(0);
    expect(cardAmountFor(Number.NaN, 1000)).toBe(0);
  });

  test("formats points for display", () => {
    expect(formatPoints(1000)).toBe("1000 pkt");
    expect(formatPoints(0)).toBe("0 pkt");
    expect(formatPoints(-5)).toBe("0 pkt");
    expect(formatPoints(Number.NaN)).toBe("0 pkt");
  });
});
