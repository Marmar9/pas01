import { describe, expect, test } from "bun:test";
import {
  buildSeatRows,
  countFreeSeats,
  isValidSeatId,
  normalizeSeatId,
  rowLabel,
  toSeatId,
} from "@/lib/seats";

describe("seat helpers", () => {
  test("maps row indexes to letters", () => {
    expect(rowLabel(0)).toBe("A");
    expect(rowLabel(25)).toBe("Z");
  });

  test("builds seat ids", () => {
    expect(toSeatId(1, 12)).toBe("B12");
  });

  test("validates seat ids", () => {
    expect(isValidSeatId("A1")).toBe(true);
    expect(isValidSeatId("B12")).toBe(true);
    expect(isValidSeatId("a1")).toBe(false);
    expect(isValidSeatId("A0")).toBe(false);
    expect(isValidSeatId("AA1")).toBe(false);
    expect(isValidSeatId("A100")).toBe(false);
  });

  test("normalizes seat ids", () => {
    expect(normalizeSeatId(" b7 ")).toBe("B7");
  });

  test("builds the full seat grid", () => {
    expect(buildSeatRows(2, 3)).toEqual([
      ["A1", "A2", "A3"],
      ["B1", "B2", "B3"],
    ]);
  });

  test("counts free seats", () => {
    expect(countFreeSeats(2, 3, ["A1", "B3"])).toBe(4);
    expect(countFreeSeats(2, 3, ["A1", "A1", "B3"])).toBe(4);
  });
});
