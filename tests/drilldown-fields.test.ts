/** `webhand drilldown --fields`: Jev maps the user's words to the page's field names (our own fixtures). */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deps, FAILED, OK } from "../src/commands/context.ts";
import { type Page, type Plan, PolicyError } from "../src/core/types.ts";
import { JevPolicy } from "../src/policies/jev.ts";
import type { FieldMatch, LabelView } from "../src/scans/drilldown.ts";
import { cli, tmpPath } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

const MEANS: Record<string, string> = { price: "価格", Total: "合計金額", stock: "在庫" };

class FieldJev extends ScriptedJev {
  asked: { wanted: string[]; labels: LabelView[] }[] = [];
  queries: string[] = [];
  noul: Record<string, number> = {};

  override async matchFields(wanted: string[], labels: LabelView[]): Promise<Map<string, FieldMatch>> {
    this.asked.push({ wanted, labels });
    return new Map(
      wanted.map((word) => {
        const found = labels.find((l) => l.label === MEANS[word]);
        return [word, { key: found?.key ?? labels[0].key, noul: this.noul[word] ?? (found ? 0.95 : 0.05) }];
      }),
    );
  }

  async selectBlocks(_page: Page, _plan: Plan, query: string, blocks: { key: string; text: string }[]) {
    this.queries.push(query);
    return new Set(blocks.filter((b) => b.text.includes("色は")).map((b) => b.key));
  }
}

/** Long enough that the paragraph about the colour starts a block of its own, past the first 500 characters. */
const FILLER = Array.from(
  { length: 8 },
  (_, i) => `<p>この商品の紹介文 ${i} です。${"よい品です。".repeat(10)}</p>`,
).join("");

test("JevPolicy.matchFields reads a Noul and a choice per word, asking no choice of a lone name", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const asked: string[][] = [];
  const policy = new JevPolicy({
    fetch: async (_url, init) => {
      asked.push(Object.keys(JSON.parse(init.body).questions));
      const choice = { choice: "2", confidence: 0.8, probabilities: { "1": 0.2, "2": 0.8 } };
      const answers = { field_1_exists: { noul: 0.9 }, field_1: choice };
      return { status: 200, json: async () => ({ answers }) };
    },
  });
  const labels = [
    { key: "1", label: "a" },
    { key: "2", label: "b" },
  ];
  expect(await policy.matchFields(["x"], labels)).toEqual(new Map([["x", { key: "2", noul: 0.9 }]]));
  expect(await policy.matchFields(["x"], labels.slice(0, 1))).toEqual(new Map([["x", { key: "1", noul: 0.9 }]]));
  expect(asked).toEqual([["field_1_exists", "field_1"], ["field_1_exists"]]);
  // An answer that lacks a word's Noul is an error, never "not found".
  await expect(policy.matchFields(["x", "y"], labels)).rejects.toThrow("Invalid Jev noul response");
});

describe("real Chrome CLI: drilldown --fields", () => {
  let cleanup: () => Promise<void>;
  let jev: FieldJev;
  let dir: string;

  beforeEach(() => {
    ({ cleanup } = isolate());
    jev = new FieldJev();
    deps.policy = () => jev;
    dir = tmpPath();
  });

  afterEach(async () => {
    await cleanup();
  });

  const detail = (price: string) => `${FILLER}
    <dl><dt>価格</dt><dd>${price}</dd></dl>
    <div class="spec">
      <div class="line"><span>合計金額</span><span>1,320円</span></div>
      <div class="line"><span>在庫</span><span>3点</span></div>
    </div>
    <p>色は青です。</p>`;

  async function drill(details: string[], ...options: string[]) {
    details.forEach((body, i) => {
      writeFileSync(join(dir, `item${i}.html`), `<title>item${i}</title><main>${body}</main>`);
    });
    const rows = details.map((_, i) => `<tr><td><a href="item${i}.html">商品 ${i}</a></td></tr>`).join("");
    writeFileSync(join(dir, "list.html"), `<title>一覧</title><main><table><tbody>${rows}</tbody></table></main>`);
    const url = pathToFileURL(join(dir, "list.html")).href;
    expect((await cli("start", "--goal", "商品を調べる", "--url", url, "--chrome", "linux")).code).toBe(OK);
    const drilled = await cli("drilldown", "--link-text", "商品", ...options);
    await cli("finish", "--status", "done");
    return drilled;
  }

  const first = (out: string) => JSON.parse(out).items[0];

  test("finds a field named in another language and one built of divs, copying their values", async () => {
    const drilled = await drill([detail("1,200円"), detail("900円")], "--fields", "price,Total");
    expect(drilled.code).toBe(OK);
    expect(first(drilled.out).fields).toEqual({ 価格: "1,200円", 合計金額: "1,320円" });
    expect(first(drilled.out).field_labels).toEqual({ price: "価格", Total: "合計金額" });
    expect(JSON.parse(drilled.out).items[1].fields.価格).toBe("900円");
    expect(first(drilled.out)).not.toHaveProperty("missing_fields");
    expect(first(drilled.out)).not.toHaveProperty("snippet");
    // One question for pages with the same field names, and only the names are sent.
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0].labels.map((l) => l.label)).toEqual(["価格", "合計金額", "在庫"]);
    expect(JSON.stringify(jev.asked)).not.toContain("1,200円");
    expect(jev.queries).toHaveLength(0);
  });

  test("names the missing field and shows the part of the page about it, not the page's start", async () => {
    const drilled = await drill([detail("1,200円")], "--fields", "price,colour");
    expect(first(drilled.out).fields).toEqual({ 価格: "1,200円" });
    expect(first(drilled.out).missing_fields).toEqual(["colour"]);
    expect(first(drilled.out).snippet).toContain("色は青です。");
    expect(first(drilled.out).snippet).not.toContain("紹介文 0");
    expect(jev.queries).toEqual(["colour"]);
  });

  test("reports an unsure field apart from the found ones", async () => {
    jev.noul = { stock: 0.5 };
    const drilled = await drill([detail("1,200円")], "--fields", "stock");
    expect(first(drilled.out).fields).toEqual({});
    expect(first(drilled.out).uncertain_fields).toEqual([{ field: "stock", label: "在庫", value: "3点" }]);
    expect(first(drilled.out)).not.toHaveProperty("missing_fields");
    expect(jev.queries).toEqual(["stock"]);
  });

  test("shows missing and unsure fields in markdown", async () => {
    jev.noul = { stock: 0.5 };
    const drilled = await drill([detail("1,200円")], "--fields", "price,stock,colour", "--format", "markdown");
    expect(drilled.out).toContain("| title | 価格 | snippet |");
    expect(drilled.out).toContain("MISSING (item0): colour");
    expect(drilled.out).toContain("UNCERTAIN (item0): stock may be 在庫=3点");
  });

  test("shows no snippet when no part of the page is about the missing field", async () => {
    const drilled = await drill([`<dl><dt>価格</dt><dd>5円</dd></dl><p>以上です。</p>`], "--fields", "colour");
    expect(first(drilled.out).missing_fields).toEqual(["colour"]);
    expect(first(drilled.out)).not.toHaveProperty("snippet");
  });

  test("fails when Jev fails, instead of calling the field missing", async () => {
    jev.matchFields = async () => {
      throw new PolicyError("Jev returned HTTP 500; no action executed.");
    };
    const drilled = await drill([detail("1,200円")], "--fields", "price");
    expect(drilled.code).toBe(FAILED);
    expect(drilled.out).toContain("DRILLDOWN FAILED: Jev returned HTTP 500");
  });
});
