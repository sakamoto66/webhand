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

test("hints offer only what worked in runs that finished as done, the most often first, and nothing when switched off", () => {
  const dir = join(tmpPath(), "knowledge");
  const knowledge = new Knowledge(dir);
  const from = "https://s.test/home";
  knowledge.record({ from, to: "https://s.test/tools", kind: "click", label: "Tools", changed: true });
  knowledge.record({ from, to: "https://s.test/more", kind: "click", label: "More", changed: true });
  knowledge.record({ from, to: "https://s.test/more", kind: "click", label: "More", changed: true });
  // Nothing worked yet: nothing is offered.
  expect(knowledge.hints(from)).toEqual([]);
  knowledge.confirm([
    { kind: "click", action: "More", url: from },
    { kind: "click", action: "More", url: from },
    { kind: "fill", action: "Name", url: from },
  ]);
  expect(knowledge.hints(from)).toEqual([
    { operation: "CLICK", label: "More", worked: "1 of 2 tries", goes_to: "/more" },
  ]);
  expect(knowledge.hints("https://s.test/other")).toEqual([]);
  expect(new Knowledge(dir, false).hints(from)).toEqual([]);
});

test("a step that led nowhere is not marked as the way that worked", () => {
  const knowledge = new Knowledge(join(tmpPath(), "knowledge"));
  const home = "https://s.test/home";
  const more = "https://s.test/more";
  const tools = "https://s.test/tools";
  knowledge.record({ from: home, to: more, kind: "click", label: "More", changed: true });
  knowledge.record({ from: more, to: tools, kind: "click", label: "Tools", changed: true });
  knowledge.record({ from: tools, to: tools, kind: "click", label: "Nothing", changed: false });
  knowledge.record({ from: tools, to: "https://s.test/billing", kind: "click", label: "Billing", changed: true });
  knowledge.confirm([
    { kind: "click", action: "More", url: home, page_changed: true },
    { kind: "answer", url: more },
    { kind: "click", action: "Tools", url: more, page_changed: true },
    { kind: "click", action: "Nothing", url: tools, page_changed: false },
    { kind: "click", action: "Billing", url: tools, page_changed: true },
  ]);
  expect(knowledge.hints(home)).toEqual([]);
  expect(knowledge.hints(more).map((h) => h.label)).toEqual(["Tools"]);
  expect(knowledge.hints(tools).map((h) => h.label)).toEqual(["Billing"]);
});

test("what is known can be listed, read and forgotten", () => {
  const knowledge = new Knowledge(join(tmpPath(), "knowledge"));
  expect(knowledge.hosts()).toEqual([]);
  knowledge.record({ from: "https://a.test/x", to: "https://a.test/y", kind: "click", label: "Go", changed: true });
  knowledge.record({ from: "https://b.test/x", to: "https://b.test/x", kind: "click", label: "Stay", changed: false });
  expect(knowledge.hosts()).toEqual([
    { host: "a.test", pages: 1, operations: 1, worked: 0 },
    { host: "b.test", pages: 1, operations: 1, worked: 0 },
  ]);
  expect(knowledge.describe("a.test")).toEqual([
    "/x (seen 1)",
    '  CLICK "Go": tried 1, page changed 1, worked 0, goes to /y',
  ]);
  expect(knowledge.forget("a.test")).toBe(1);
  expect(knowledge.forget("a.test")).toBe(0);
  expect(knowledge.forget(null)).toBe(1);
  expect(knowledge.hosts()).toEqual([]);
});

test("the knowledge command lists, shows and clears what was learned, for the user's folder", async () => {
  const { cli } = await import("./helpers.ts");
  const { Knowledge: Learned } = await import("../src/knowledge.ts");
  expect((await cli("knowledge", "list")).out).toBe("KNOWN SITES: (none)\n");
  new Learned().record({ from: "https://a.test/x", to: "https://a.test/y", kind: "click", label: "Go", changed: true });
  expect((await cli("knowledge", "list")).out).toBe("a.test: 1 pages, 1 operations, 0 that worked\n");
  expect((await cli("knowledge", "show", "a.test")).out).toContain('CLICK "Go": tried 1');
  expect((await cli("knowledge", "show", "b.test")).code).toBe(1);
  expect((await cli("knowledge", "clear", "a.test")).out).toBe("FORGOT 1 site (a.test)\n");
  expect((await cli("knowledge", "list")).out).toBe("KNOWN SITES: (none)\n");
});

test("a control inside a list item is not recorded: its label is the page's content", () => {
  const knowledge = new Knowledge(join(tmpPath(), "knowledge"));
  const step = { from: "https://s.test/results", to: "https://s.test/hotel", kind: "click", changed: true };
  expect(knowledge.record({ ...step, label: "Hotel Aurora", inItem: true })).toBe(false);
  expect(knowledge.record({ ...step, label: "Next page", inItem: false })).toBe(true);
  expect(knowledge.hosts()).toEqual([{ host: "s.test", pages: 1, operations: 1, worked: 0 }]);
});
