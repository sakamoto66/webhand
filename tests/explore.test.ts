import { expect, test } from "vitest";
import {
  clip,
  dedupe,
  describeFindings,
  ExploreError,
  hostAllowed,
  isDeadEnd,
  loggedFindings,
  parseAllow,
  plainUrl,
} from "../src/explore.ts";

test("--allow-domain takes hosts only", () => {
  expect(parseAllow(["Shop.test", "localhost:8080", "shop.test"])).toEqual(["shop.test", "localhost:8080"]);
  expect(() => parseAllow([])).toThrow(ExploreError);
  for (const bad of ["https://shop.test", "shop.test/cart", "*.shop.test", ""]) {
    expect(() => parseAllow([bad])).toThrow(/takes a host/);
  }
});

test("a host matches itself and its subdomains, and a port in the rule must match", () => {
  const allow = ["shop.test", "localhost:8080"];
  expect(hostAllowed("https://shop.test/cart?x=1", allow)).toBe(true);
  expect(hostAllowed("https://api.shop.test/", allow)).toBe(true);
  expect(hostAllowed("https://evilshop.test/", allow)).toBe(false);
  expect(hostAllowed("https://shop.test.evil.com/", allow)).toBe(false);
  expect(hostAllowed("http://localhost:8080/", allow)).toBe(true);
  expect(hostAllowed("http://localhost:9090/", allow)).toBe(false);
  expect(hostAllowed("about:blank", allow)).toBe(true);
  expect(hostAllowed("file:///etc/passwd", allow)).toBe(false);
  expect(hostAllowed("not a url", allow)).toBe(false);
});

test("a finding keeps the address without its query, and a clipped one-line message", () => {
  expect(plainUrl("https://shop.test/cart?token=abc#x=1")).toBe("shop.test/cart");
  expect(plainUrl("nonsense")).toBe("(unknown)");
  expect(clip("Failed  to load\nhttps://shop.test/api?key=secret now")).toBe("Failed to load shop.test/api now");
  expect(clip("x".repeat(500))).toHaveLength(201);
});

test("a page with nothing to do but wait or switch tabs is a dead end", () => {
  expect(isDeadEnd({ actions: [{ kind: "wait" }] })).toBe(true);
  expect(isDeadEnd({ actions: [{ kind: "tab" }, { kind: "wait" }] })).toBe(true);
  expect(isDeadEnd({ actions: [{ kind: "click" }, { kind: "wait" }] })).toBe(false);
});

test("the same signal on the same address with the same message is one finding", () => {
  const a = { signal: "http_5xx" as const, url: "shop.test/api", detail: "", status: 500 };
  expect(dedupe([a, { ...a }, { ...a, status: 503 }])).toHaveLength(2);
});

test("findings are read back from the log and described as candidates with their steps", () => {
  const log = [
    JSON.stringify({ type: "page" }),
    JSON.stringify({ type: "finding", signal: "http_5xx", url: "shop.test/api", detail: "", status: 500, step: 2 }),
    JSON.stringify({ type: "finding", signal: "http_5xx", url: "shop.test/api", detail: "", status: 500, step: 3 }),
    JSON.stringify({ type: "finding", signal: "bogus", url: "x", step: 1 }),
    "{broken",
  ].join("\n");
  const found = loggedFindings(log);
  expect(found).toHaveLength(2);
  const text = describeFindings(found, ["1. CLICK “Load”"]);
  expect(text).toContain("FINDINGS: 1 candidate (not verdicts");
  expect(text).toContain("1. http_5xx  shop.test/api  status 500  (after step 2)");
  expect(text).toContain("STEPS:\n1. CLICK “Load”");
  expect(describeFindings([], [])).toBe("FINDINGS: none");
});
