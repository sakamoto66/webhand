import { describe, expect, it } from "vitest";
import { ExpectationError, evaluate, parseExpectation, seenWhole } from "../src/check.ts";
import type { Page } from "../src/types.ts";

const field = (node: number, role: string, label: string, extra: Record<string, unknown>) => ({
  node,
  role,
  label,
  kind: "fill",
  id: `e${node}`,
  ...extra,
});

function page(overrides: Page = {}): Page {
  return {
    url: "https://example.test/complete?x=1",
    title: "完了",
    h: 800,
    scroll: { y: 0, height: 800 },
    text: "予約を完了しました。\n合計 12,000",
    actions: [
      field(1, "textbox", "クーポン", { value: "SAVE10" }),
      field(2, "checkbox", "同意する", { kind: "click", checked: true, value: "" }),
      field(3, "checkbox", "メール", { kind: "click", checked: false, value: "" }),
    ],
    ...overrides,
  };
}

const check = (raw: string, p: Page = page()) => evaluate(p, parseExpectation(raw));

describe("parseExpectation", () => {
  it("splits subject and value at the last =", () => {
    expect(parseExpectation("field:合計 = 15,000").subject).toBe("合計");
    expect(parseExpectation("field:a=b=c")).toMatchObject({ subject: "a=b", expected: "c" });
  });
  it.each(["nope:x", "text:", "field:x", "checked:a=maybe", "count:button=two"])("rejects %s", (raw) => {
    expect(() => parseExpectation(raw)).toThrow(ExpectationError);
  });
});

describe("evaluate", () => {
  it("text: PASS quotes the line, FAIL only when the whole page was seen", () => {
    expect(check("text:予約を完了しました")).toMatchObject({ verdict: "PASS", evidence: '"予約を完了しました。"' });
    expect(check("text:エラー").verdict).toBe("FAIL");
    const long = page({ scroll: { y: 0, height: 2000 } });
    expect(check("text:エラー", long)).toMatchObject({ verdict: "INCONCLUSIVE", reason: "not_visible" });
    expect(check("text:エラー", { ...long, read: { text: "end" } }).verdict).toBe("FAIL");
  });
  it("text: whitespace is normalized, nothing looser", () => {
    expect(check("text:合計  12,000").verdict).toBe("PASS");
    expect(check("text:合計 12000").verdict).toBe("FAIL");
  });
  it("no-text: found is FAIL; absent is PASS only when the whole page was seen", () => {
    expect(check("no-text:合計").verdict).toBe("FAIL");
    expect(check("no-text:エラー").verdict).toBe("PASS");
    expect(check("no-text:エラー", page({ scroll: { y: 0, height: 2000 } })).verdict).toBe("INCONCLUSIVE");
  });
  it("field: exact value, shows both on FAIL", () => {
    expect(check("field:クーポン=SAVE10").verdict).toBe("PASS");
    expect(check("field:クーポン=").evidence).toBe('expected "" observed "SAVE10" (textbox [1])');
  });
  it("field: unobserved or repeated labels are INCONCLUSIVE, not FAIL", () => {
    expect(check("field:パスワード=x")).toMatchObject({ verdict: "INCONCLUSIVE", reason: "not_found" });
    const twin = page({
      actions: [field(1, "textbox", "a", { value: "1" }), field(2, "textbox", "a", { value: "2" })],
    });
    expect(check("field:a=1", twin)).toMatchObject({ verdict: "INCONCLUSIVE", reason: "ambiguous" });
  });
  it("checked", () => {
    expect(check("checked:同意する=true").verdict).toBe("PASS");
    expect(check("checked:メール=true").verdict).toBe("FAIL");
  });
  it("count needs the whole page", () => {
    expect(check("count:checkbox=2").verdict).toBe("PASS");
    expect(check("count:checkbox=3").verdict).toBe("FAIL");
    expect(check("count:checkbox=2", page({ omitted_regions: 1 })).verdict).toBe("INCONCLUSIVE");
  });
  it("url and title", () => {
    expect(check("url:/complete").verdict).toBe("PASS");
    expect(check("url:/other").verdict).toBe("FAIL");
    expect(check("url:https://example.test/complete?x=1").verdict).toBe("PASS");
    expect(check("title:完了").verdict).toBe("PASS");
    expect(check("title:完").verdict).toBe("FAIL");
  });
});

describe("seenWhole", () => {
  it("is false for a cut region or an unseen frame", () => {
    expect(seenWhole(page())).toBe(true);
    expect(seenWhole(page({ regions: [{ shown_chars: 10, text_chars: 50 }] }))).toBe(false);
    expect(seenWhole(page({ unseen: { iframe: 1 } }))).toBe(false);
  });
});
