import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { memoryEnabled, memoryUseEnabled, pageShape, plainLabel, SiteMemory } from "../src/memory.ts";
import { home } from "../src/workspace.ts";
import { tmpPath } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  const dir = join(tmpPath(), "memory");
  const memory = new SiteMemory(dir);
  const step = (to: string, changed: boolean, label = "Add to cart", kind = "click") =>
    memory.record({ from: "https://s.test/items/7", to, kind, label, changed });
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
  const memory = new SiteMemory(join(tmpPath(), "memory"));
  for (let i = 0; i < 200; i++)
    memory.record({
      from: `https://s.test/p${i}x`,
      to: "https://s.test/",
      kind: "click",
      label: "Go",
      changed: true,
    });
  expect(
    memory.record({
      from: "https://s.test/extra",
      to: "https://s.test/",
      kind: "click",
      label: "Go",
      changed: true,
    }),
  ).toBe(false);
});

test("hints offer only what worked in runs that finished as done, the most often first, and nothing when switched off", () => {
  const dir = join(tmpPath(), "memory");
  const memory = new SiteMemory(dir);
  const from = "https://s.test/home";
  memory.record({ from, to: "https://s.test/tools", kind: "click", label: "Tools", changed: true });
  memory.record({ from, to: "https://s.test/more", kind: "click", label: "More", changed: true });
  memory.record({ from, to: "https://s.test/more", kind: "click", label: "More", changed: true });
  // Nothing worked yet: nothing is offered.
  expect(memory.hints(from)).toEqual([]);
  memory.confirm([
    { kind: "click", action: "More", url: from },
    { kind: "click", action: "More", url: from },
    { kind: "fill", action: "Name", url: from },
  ]);
  expect(memory.hints(from)).toEqual([{ operation: "CLICK", label: "More", worked: "1 of 2 tries", goes_to: "/more" }]);
  expect(memory.hints("https://s.test/other")).toEqual([]);
  expect(new SiteMemory(dir, false).hints(from)).toEqual([]);
});

test("a step that led nowhere is not marked as the way that worked", () => {
  const memory = new SiteMemory(join(tmpPath(), "memory"));
  const homeUrl = "https://s.test/home";
  const more = "https://s.test/more";
  const tools = "https://s.test/tools";
  memory.record({ from: homeUrl, to: more, kind: "click", label: "More", changed: true });
  memory.record({ from: more, to: tools, kind: "click", label: "Tools", changed: true });
  memory.record({ from: tools, to: tools, kind: "click", label: "Nothing", changed: false });
  memory.record({ from: tools, to: "https://s.test/billing", kind: "click", label: "Billing", changed: true });
  memory.confirm([
    { kind: "click", action: "More", url: homeUrl, page_changed: true },
    { kind: "answer", url: more },
    { kind: "click", action: "Tools", url: more, page_changed: true },
    { kind: "click", action: "Nothing", url: tools, page_changed: false },
    { kind: "click", action: "Billing", url: tools, page_changed: true },
  ]);
  expect(memory.hints(homeUrl)).toEqual([]);
  expect(memory.hints(more).map((h) => h.label)).toEqual(["Tools"]);
  expect(memory.hints(tools).map((h) => h.label)).toEqual(["Billing"]);
});

test("what is remembered can be listed, read and forgotten", () => {
  const memory = new SiteMemory(join(tmpPath(), "memory"));
  expect(memory.hosts()).toEqual([]);
  memory.record({ from: "https://a.test/x", to: "https://a.test/y", kind: "click", label: "Go", changed: true });
  memory.record({ from: "https://b.test/x", to: "https://b.test/x", kind: "click", label: "Stay", changed: false });
  expect(memory.hosts()).toEqual([
    { host: "a.test", pages: 1, operations: 1, worked: 0 },
    { host: "b.test", pages: 1, operations: 1, worked: 0 },
  ]);
  expect(memory.describe("a.test")).toEqual([
    "/x (seen 1)",
    '  CLICK "Go": tried 1, page changed 1, worked 0, goes to /y',
  ]);
  expect(memory.forget("a.test")).toBe(1);
  expect(memory.forget("a.test")).toBe(0);
  expect(memory.forget(null)).toBe(1);
  expect(memory.hosts()).toEqual([]);
});

test("the memory command (and legacy knowledge alias) lists, shows and clears remembered sites", async () => {
  const { cli } = await import("./helpers.ts");
  expect((await cli("memory", "list")).out).toBe("REMEMBERED SITES: (none)\n");
  new SiteMemory().record({
    from: "https://a.test/x",
    to: "https://a.test/y",
    kind: "click",
    label: "Go",
    changed: true,
  });
  expect((await cli("memory", "list")).out).toBe("a.test: 1 pages, 1 operations, 0 that worked\n");
  expect((await cli("knowledge", "list")).out).toBe("a.test: 1 pages, 1 operations, 0 that worked\n");
  expect((await cli("memory", "show", "a.test")).out).toContain('CLICK "Go": tried 1');
  expect((await cli("memory", "show", "b.test")).code).toBe(1);
  expect((await cli("memory", "clear", "a.test")).out).toBe("FORGOT 1 site (a.test)\n");
  expect((await cli("memory", "list")).out).toBe("REMEMBERED SITES: (none)\n");
});

test("legacy $WEBHAND_HOME/knowledge is migrated to memory on first use", () => {
  const legacyDir = join(home(), "knowledge");
  const memoryDir = join(home(), "memory");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "old.test.json"),
    JSON.stringify({
      host: "old.test",
      pages: {
        "/x": {
          seen: 1,
          transitions: { "click|Go": { kind: "click", label: "Go", tried: 1, changed: 1, ok: 1, to: { "/y": 1 } } },
        },
      },
    }),
  );
  const memory = new SiteMemory();
  expect(existsSync(memoryDir)).toBe(true);
  expect(existsSync(legacyDir)).toBe(false);
  expect(memory.hosts()).toEqual([{ host: "old.test", pages: 1, operations: 1, worked: 1 }]);
});

test("WEBHAND_MEMORY and legacy WEBHAND_KNOWLEDGE env vars both switch memory off", () => {
  expect(memoryEnabled()).toBe(true);
  expect(memoryUseEnabled()).toBe(true);
  vi.stubEnv("WEBHAND_MEMORY", "0");
  expect(memoryEnabled()).toBe(false);
  vi.unstubAllEnvs();
  vi.stubEnv("WEBHAND_KNOWLEDGE", "0");
  expect(memoryEnabled()).toBe(false);
  vi.unstubAllEnvs();
  vi.stubEnv("WEBHAND_MEMORY_USE", "0");
  expect(memoryUseEnabled()).toBe(false);
  vi.unstubAllEnvs();
  vi.stubEnv("WEBHAND_KNOWLEDGE_USE", "0");
  expect(memoryUseEnabled()).toBe(false);
});

test("a control inside a list item is not recorded: its label is the page's content", () => {
  const memory = new SiteMemory(join(tmpPath(), "memory"));
  const step = { from: "https://s.test/results", to: "https://s.test/hotel", kind: "click", changed: true };
  expect(memory.record({ ...step, label: "Hotel Aurora", inItem: true })).toBe(false);
  expect(memory.record({ ...step, label: "Next page", inItem: false })).toBe(true);
  expect(memory.hosts()).toEqual([{ host: "s.test", pages: 1, operations: 1, worked: 0 }]);
});
