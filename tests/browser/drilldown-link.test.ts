/** `webhand drilldown`: Jev picks the link of each row that opens the item's own detail page (our own fixtures). */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deps, FAILED, OK } from "../../src/commands/context.ts";
import { PolicyError } from "../../src/core/types.ts";
import { JevPolicy } from "../../src/policies/jev.ts";
import type { LinkView } from "../../src/scans/drilldown.ts";
import { cli, readEvents, tmpPath } from "../helpers.ts";
import { isolate, ScriptedJev } from "../jev.ts";

/** Picks the link whose path starts with "item", with a fixed probability that such a link exists. */
class LinkJev extends ScriptedJev {
  asked: { row: string; links: LinkView[] }[] = [];
  noul: (row: string) => number = () => 0.95;

  override async detailLink(row: string, links: LinkView[]) {
    this.asked.push({ row, links });
    const found = links.find((link) => link.path.startsWith("item"));
    return { key: found?.key ?? links[0].key, noul: this.noul(row) };
  }
}

test("JevPolicy.detailLink reads the Noul and the choice, asking no choice of a lone link", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const asked: string[][] = [];
  const policy = new JevPolicy({
    fetch: async (_url, init) => {
      const questions = Object.keys(JSON.parse(init.body).questions);
      asked.push(questions);
      const choice = { choice: "2", confidence: 0.8, probabilities: { "1": 0.2, "2": 0.8 } };
      return { status: 200, json: async () => ({ answers: { has_detail_link: { noul: 0.9 }, detail_link: choice } }) };
    },
  });
  const links = [
    { key: "1", name: "a", path: "/a" },
    { key: "2", name: "b", path: "/b" },
  ];
  expect(await policy.detailLink("row", links)).toEqual({ key: "2", noul: 0.9 });
  expect(await policy.detailLink("row", links.slice(0, 1))).toEqual({ key: "1", noul: 0.9 });
  expect(asked).toEqual([["has_detail_link", "detail_link"], ["has_detail_link"]]);
  expect(policy.calls.map((call) => call.purpose)).toEqual(["detail_link", "detail_link"]);
});

describe("real Chrome CLI: drilldown detail link", () => {
  let cleanup: () => Promise<void>;
  let log: string;
  let jev: LinkJev;
  let dir: string;

  beforeEach(() => {
    ({ cleanup, log } = isolate());
    jev = new LinkJev();
    deps.policy = () => jev;
    dir = tmpPath();
    for (const name of ["item1", "item2", "item3", "seller1", "seller2", "seller3"]) {
      writeFileSync(join(dir, `${name}.html`), `<title>${name}</title><main>${name}</main>`);
    }
  });

  afterEach(async () => {
    await cleanup();
  });

  /** A table whose rows start with a link to the seller, not to the item. */
  const row = (n: number) =>
    `<tr><td><a href="seller${n}.html?session=SECRET${n}#top"><img alt="出品者 ${n}" width="20" height="20"></a></td>
      <td>商品 ${n}</td><td><a href="item${n}.html?token=SECRET${n}">商品 ${n} を見る</a></td></tr>`;

  async function drill(rows: string, ...options: string[]) {
    writeFileSync(join(dir, "list.html"), `<title>一覧</title><main><table><tbody>${rows}</tbody></table></main>`);
    const url = pathToFileURL(join(dir, "list.html")).href;
    expect((await cli("start", "--goal", "商品を調べる", "--url", url, "--chrome", "linux")).code).toBe(OK);
    const drilled = await cli("drilldown", ...options);
    const observed = await cli("observe");
    await cli("finish", "--status", "done");
    return { ...drilled, observed: observed.out };
  }

  const titles = (out: string) => JSON.parse(out).items.map((item: { title: string }) => item.title);

  test("opens the item's page, not the first link, asking once for rows of one shape", async () => {
    const drilled = await drill(row(1) + row(2) + row(3));
    expect(drilled.code).toBe(OK);
    expect(titles(drilled.out)).toEqual(["item1", "item2", "item3"]);
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0].links).toEqual([
      { key: "1", name: "出品者 1", path: "seller1.html" },
      { key: "2", name: "商品 1 を見る", path: "item1.html" },
    ]);
    // Neither a query value nor the folder of a local file reaches Jev.
    expect(JSON.stringify(jev.asked)).not.toContain("SECRET");
    expect(JSON.stringify(jev.asked)).not.toContain(dir);
    expect(drilled.out).not.toContain("link_uncertain");
    expect(readEvents(log).filter((e) => e.type === "drilldown_link")).toHaveLength(1);
  });

  test("asks again for rows with other links, and skips and counts those with no detail link", async () => {
    jev.noul = (text) => (text.includes("広告") ? 0.1 : 0.95);
    const ad = `<tr><td>広告</td><td><a href="seller3.html">広告主</a></td></tr>`;
    const drilled = await drill(ad + row(1) + ad.replace("seller3", "seller2") + row(2));
    expect(drilled.code).toBe(OK);
    expect(titles(drilled.out)).toEqual(["item1", "item2"]);
    expect(jev.asked).toHaveLength(2);
    expect(JSON.parse(drilled.out)).toMatchObject({ seen: 4, matched: 4, visited: 2, skipped_no_link: 2 });
    expect(JSON.parse(drilled.out).truncated).toBe(false);
  });

  test("does not let a skipped row use up --max-items", async () => {
    jev.noul = (text) => (text.includes("広告") ? 0.1 : 0.95);
    const ad = `<tr><td>広告</td><td><a href="seller3.html">広告主</a></td></tr>`;
    const drilled = await drill(ad + row(1) + row(2) + row(3), "--max-items", "2");
    expect(titles(drilled.out)).toEqual(["item1", "item2"]);
    expect(JSON.parse(drilled.out)).toMatchObject({ visited: 2, skipped_no_link: 1, truncated: true });
  });

  test("keeps the first link and says so when Jev is unsure", async () => {
    jev.noul = () => 0.5;
    const drilled = await drill(row(1) + row(2));
    expect(titles(drilled.out)).toEqual(["seller1", "seller2"]);
    expect(JSON.parse(drilled.out).items.map((i: { link_uncertain?: boolean }) => i.link_uncertain)).toEqual([
      true,
      true,
    ]);
  });

  test("says in a table which rows were skipped or unsure", async () => {
    jev.noul = (text) => (text.includes("広告") ? 0.1 : 0.5);
    const ad = `<tr><td>広告</td><td><a href="seller3.html">広告主</a></td></tr>`;
    const drilled = await drill(row(1) + ad, "--format", "table");
    expect(drilled.out).toContain("skipped_no_detail_link=1");
    expect(drilled.out).toContain("UNCERTAIN LINK (first link of the row used): seller1");
  });

  test("takes --link-text as the choice and asks nothing", async () => {
    const drilled = await drill(row(1) + row(2), "--link-text", "を見る");
    expect(titles(drilled.out)).toEqual(["item1", "item2"]);
    expect(jev.asked).toHaveLength(0);
  });

  test("fails, visiting nothing and staying on the list, when Jev fails", async () => {
    jev.detailLink = async () => {
      throw new PolicyError("Jev returned HTTP 500; no action executed.");
    };
    const drilled = await drill(row(1));
    expect(drilled.code).toBe(FAILED);
    expect(drilled.out).toContain("DRILLDOWN FAILED: Jev returned HTTP 500");
    expect(drilled.observed).toContain("list.html");
  });
});
