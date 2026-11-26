/** `webhand drilldown`: finding the rows of lists built without tables (our own fixtures). */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OK } from "../src/commands/context.ts";
import { cli, tmpPath } from "./helpers.ts";
import { isolate } from "./jev.ts";

describe("real Chrome CLI: drilldown rows", () => {
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    ({ cleanup } = isolate());
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Writes the list and one detail page per name, drills down, and returns the titles of the pages visited. */
  async function visitedTitles(list: string, details: string[]): Promise<string[]> {
    const dir = tmpPath();
    for (const name of details) writeFileSync(join(dir, `${name}.html`), `<title>${name}</title><main>${name}</main>`);
    writeFileSync(join(dir, "list.html"), `<title>一覧</title>${list}`);
    const url = pathToFileURL(join(dir, "list.html")).href;
    expect((await cli("start", "--goal", "商品を調べる", "--url", url, "--chrome", "linux")).code).toBe(OK);
    const drilled = await cli("drilldown", "--format", "json");
    expect(drilled.code).toBe(OK);
    await cli("finish", "--status", "done");
    return JSON.parse(drilled.out).items.map((item: { title: string }) => item.title);
  }

  test("finds a list of div cards beside another list of li elements", async () => {
    const card = (name: string) => `<div class="card"><h3>${name}</h3><a href="${name}.html">詳細</a></div>`;
    const titles = await visitedTitles(
      `<main>
        <ul><li><a href="help.html">ヘルプ</a></li><li><a href="terms.html">規約</a></li></ul>
        <div>${card("shirt")}${card("jacket")}${card("socks")}</div>
      </main>`,
      ["help", "terms", "shirt", "jacket", "socks"],
    );
    expect(titles).toEqual(expect.arrayContaining(["shirt", "jacket", "socks"]));
  });

  test("takes a div card as the row, not the tags listed inside it", async () => {
    const card = (name: string) =>
      `<div class="card"><a href="${name}.html">${name} の詳しい説明を読む</a><p>在庫があります。すぐに発送します。</p>
        <ul><li><a href="tag.html">タグ</a></li></ul></div>`;
    const titles = await visitedTitles(`<main><div>${card("shirt")}${card("jacket")}${card("socks")}</div></main>`, [
      "shirt",
      "jacket",
      "socks",
      "tag",
    ]);
    expect(titles).toEqual(["shirt", "jacket", "socks"]);
  });

  test("keeps rows too few to be seen as a repeated list, and leaves the header row out", async () => {
    const titles = await visitedTitles(
      `<main><table>
        <thead><tr><th><a href="sort.html">名前順</a></th></tr></thead>
        <tbody><tr><td><a href="shirt.html">shirt</a></td></tr></tbody>
      </table>
      <ul><li><a href="jacket.html">jacket</a></li></ul></main>`,
      ["sort", "shirt", "jacket"],
    );
    expect(titles).toEqual(["shirt", "jacket"]);
  });
});
