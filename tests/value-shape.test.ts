import { expect, test } from "vitest";
import { dateShape } from "../src/core/value-shape.ts";

test("a date has a shape that keeps its separators and hides its digits", () => {
  expect(dateShape("04/03/2026")).toBe("99/99/9999");
  expect(dateShape("2026-3-4")).toBe("9999-9-9");
  expect(dateShape("04.03.26")).toBe("99.99.99");
  expect(dateShape("2026年3月4日")).toBe("9999年9月9日");
  expect(dateShape("March 4, 2026")).toBe("Month 9, 9999");
  expect(dateShape("4 Mar 2026")).toBe("9 Mon 9999");
});

test("a text that is not a date has no shape", () => {
  for (const text of ["Mika Tanaka", "mika@example.com", "03-1234-5678", "192.168.0.1", "12345678", "04/03-2026", ""]) {
    expect(dateShape(text)).toBeNull();
  }
});
