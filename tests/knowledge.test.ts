import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Knowledge, pageShape, plainLabel } from "../src/knowledge.ts";
import { tmpPath } from "./helpers.ts";

test("a page's shape takes out ids and query values, and keeps the host", () => {
  expect(pageShape("https://Shop.example.com/items/123/reviews?sort=new&page=2#top")).toEqual({
    host: "shop.example.com",
    shape: "/items/:n/reviews?page&sort",
  });
  expect(pageShape("https://a.test/u/3f2a9c1b-0000-4000-8000-123456789abc")?.shape).toBe("/u/:id");
  expect(pageShape("https://a.test/")?.shape).toBe("/");
  expect(pageShape("not a url")).toBeNull();
  expect(pageShape("about:blank")).toBeNull();
});

test("only plain control labels are kept: no address, no long number, nothing long", () => {
  expect(plainLabel("  Add   to cart ")).toBe("Add to cart");
  expect(plainLabel("mika@example.com")).toBeNull();
  expect(plainLabel("Order 1234567")).toBeNull();
  expect(plainLabel("x".repeat(61))).toBeNull();
  expect(plainLabel("https://a.test")).toBeNull();
  expect(plainLabel("")).toBeNull();
});

test("a run's steps are counted per page shape and operation, and where the page went", () => {
  const dir = join(tmpPath(), "knowledge");
  const knowledge = new Knowledge(dir);
  const step = (to: string, changed: boolean, label = "Add to cart", kind = "click") =>
    knowledge.record({ from: "https://s.test/items/7", to, kind, label, changed });
  expect(step("https://s.test/cart", true)).toBe(true);
  expect(step("https://s.test/items/7", false)).toBe(true);
  expect(step("https://s.test/cart", true)).toBe(true);
  // Typing is never kept, nor a label that is not plain.
  expect(step("https://s.test/items/7", true, "Name", "fill")).toBe(false);
  expect(step("https://s.test/items/7", true, "me@example.com")).toBe(false);
  const saved = JSON.parse(readFileSync(join(dir, "s.test.json"), "utf8"));
  expect(saved.pages["/items/:n"].seen).toBe(3);
  expect(saved.pages["/items/:n"].transitions["click|Add to cart"]).toEqual({
    kind: "click",
    label: "Add to cart",
    tried: 3,
    changed: 2,
    to: { "/cart": 2 },
  });
  expect(readFileSync(join(dir, "s.test.json"), "utf8")).not.toContain('example.com"');
});

test("a page the site has too many of is not added past the limit", () => {
  const knowledge = new Knowledge(join(tmpPath(), "knowledge"));
  for (let i = 0; i < 200; i++)
    knowledge.record({
      from: `https://s.test/p${i}x`,
      to: "https://s.test/",
      kind: "click",
      label: "Go",
      changed: true,
    });
  expect(
    knowledge.record({
      from: "https://s.test/extra",
      to: "https://s.test/",
      kind: "click",
      label: "Go",
      changed: true,
    }),
  ).toBe(false);
});
