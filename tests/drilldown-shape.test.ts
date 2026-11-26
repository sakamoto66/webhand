/** Which rows of a drilldown list reuse Jev's answer about the detail link, and how often it is asked. No browser. */

import { expect, test } from "vitest";
import type { Recorder } from "../src/core/metrics.ts";
import type { Page } from "../src/core/types.ts";
import type { Driver } from "../src/ipc/remote.ts";
import { drilldownScan, type LinkChooser, type LinkView } from "../src/scans/drilldown.ts";

const LIST = "https://shop.example/list";

/** A table row: each cell holds one link, given as [name, path]. */
function row(...links: [string, string][]) {
  return {
    row: links.map(([name]) => name).join(" "),
    list: "TABLE.>TBODY.>TR.",
    bare: false,
    links: links.map(([name, path], i) => ({ href: new URL(path, LIST).href, name, at: `td:${i + 1}>a:1` })),
  };
}

/**
 * Drills down the rows, and the rows each "load more" adds, with a Jev that answers by `noul` and takes the link `take`
 * of the row it is shown.
 */
async function drill(
  rows: ReturnType<typeof row>[],
  noul: (links: LinkView[]) => number = () => 0.95,
  take = 0,
  more: ReturnType<typeof row>[][] = [],
) {
  let at = LIST;
  let shown = rows;
  const driver = {
    observe: async () => ({ url: LIST }),
    goto: async (url: string) => {
      at = url;
    },
    evaluate: async () => (at === LIST ? shown : { url: at, title: "", fields: {} }),
  } as unknown as Driver;
  const asked: LinkView[][] = [];
  const chooser: LinkChooser = {
    calls: [],
    detailLink: async (_row, links) => {
      asked.push(links);
      return { key: links[take].key, noul: noul(links) };
    },
  };
  const events: { type: string; fields: Record<string, unknown> }[] = [];
  const recorder = {
    call: () => {},
    event: (type: string, fields: Record<string, unknown>) => events.push({ type, fields }),
  } as unknown as Recorder;
  const later = [...more];
  const loadMore = async (page: Page) => {
    const next = later.shift();
    if (!next) return null;
    shown = next;
    return page;
  };
  const plan = { goal: "g", steps: [], values: [] };
  const options = { linkChooser: chooser, maxItems: 100, ...(more.length ? { loadMore } : {}) };
  const result = await drilldownScan(driver, null, plan, options, recorder);
  const path = (url: string) => url.replace("https://shop.example", "");
  return {
    asked: asked.length,
    visited: result.items.map((item) => path(item.url)),
    uncertain: result.items.filter((item) => item.link_uncertain).map((item) => path(item.url)),
    skipped: result.skipped_no_link ?? 0,
    events,
  };
}

const deletes = (links: LinkView[]) => (links[0].path.includes("delete") ? 0.05 : 0.95);
const times = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
/** Words with no digit in them, different for each number. */
const word = (i: number) => `item-${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}`;

test("does not reuse the answer about /users/3/edit for /users/4/delete", async () => {
  const drilled = await drill([row(["Edit", "/users/3/edit"]), row(["Delete", "/users/4/delete"])], deletes);
  expect(drilled).toMatchObject({ asked: 2, visited: ["/users/3/edit"] });
});

test("tells action words apart by their paths alone", async () => {
  const drilled = await drill([row(["開く", "/users/3/edit"]), row(["開く", "/users/4/delete"])], deletes);
  expect(drilled).toMatchObject({ asked: 2, visited: ["/users/3/edit"] });
});

test("tells actions apart by a query that is never sent", async () => {
  const drilled = await drill([row(["開く", "/act?do=edit&id=3"]), row(["開く", "/act?do=delete&id=4"])], () => 0.95);
  expect(drilled.asked).toBe(2);
});

test("asks about each action of a column where actions repeat, even one used once", async () => {
  const rows = [
    ...times(6, (i) => row(["Edit", `/users/${i}/edit`])),
    row(["Delete", "/users/7/delete"]),
    row(["Restore", "/users/8/restore"]),
  ];
  const drilled = await drill(rows, (links) => (links[0].name === "Edit" ? 0.95 : 0.05));
  expect(drilled.asked).toBe(3);
  expect(drilled.visited).toHaveLength(6);
});

test("asks once for 100 rows whose titles and paths differ", async () => {
  const rows = times(100, (i) => row([word(i), `/items/${word(i)}`], ["Edit", `/items/${i}/edit`]));
  expect((await drill(rows)).asked).toBe(1);
});

test("asks once for titled rows whose other columns repeat sellers and categories", async () => {
  const rows = times(24, (i) =>
    row(
      [word(i), `/items/${word(i)}`],
      [`seller ${word(i % 4)}`, `/s/${word(i % 4)}`],
      [word(i % 3), `/c/${word(i % 3)}`],
    ),
  );
  const drilled = await drill(rows);
  expect(drilled.asked).toBe(1);
  expect(drilled.visited).toHaveLength(24);
});

test("asks once more for a title that two rows share", async () => {
  const rows = times(10, (i) => row([word(i === 9 ? 0 : i), `/items/${word(i)}`]));
  expect((await drill(rows)).asked).toBe(2);
});

test("treats numbers in names and paths as the same word", async () => {
  const rows = times(10, (i) => row([`注文 #${i + 100}`, `/orders/${i + 100}`]));
  expect((await drill(rows)).asked).toBe(1);
});

test("asks once per title when every title is shared by two rows", async () => {
  const rows = times(20, (i) => row([word(i % 10), `/items/${word(i)}`]));
  expect((await drill(rows)).asked).toBe(10);
});

test("conditions an unsure answer on the first link, which is the one visited", async () => {
  const rows = times(12, (i) => row([word(i), `/items/${word(i)}`], [word(i % 3), `/c/${word(i % 3)}`]));
  const drilled = await drill(rows, () => 0.5, 1);
  expect(drilled.asked).toBe(1);
});

/** A row whose detail link, the second, is of the kind `kind`: each new kind needs a question. */
const kinded = (i: number, kind: number) =>
  row([`seller ${word(i)}`, `/s/${word(i)}`], [word(kind), `/items/${word(i)}`]);
const limits = (events: { type: string; fields: Record<string, unknown> }[]) =>
  events.filter((event) => event.type === "drilldown_link_limit");

test("asks at most 10 link questions, then takes the first link as unsure, and still reuses answers", async () => {
  // 15 kinds, each on rows i and i + 15.
  const drilled = await drill(
    times(30, (i) => kinded(i, i % 15)),
    () => 0.95,
    1,
  );
  expect(drilled.asked).toBe(10);
  const over = (i: number) => i % 15 >= 10;
  expect(drilled.visited).toEqual(times(30, (i) => `/${over(i) ? "s" : "items"}/${word(i)}`));
  expect(drilled.uncertain).toEqual(drilled.visited.filter((url) => url.startsWith("/s/")));
  expect(drilled.skipped).toBe(0);
  expect(limits(drilled.events)).toEqual([{ type: "drilldown_link_limit", fields: { attempt: 1, limit: 10 } }]);
  expect(drilled.events.find((event) => event.type === "drilldown_end")?.fields.link_limit_rows).toBe(10);
});

test("counts the questions of every page loaded by --more together", async () => {
  const page = (from: number) => times(8, (i) => [kinded(from + i, from + i), kinded(from + i + 100, from + i)]).flat();
  const drilled = await drill(page(0), () => 0.95, 1, [page(8), page(16)]);
  expect(drilled.asked).toBe(10);
  expect(drilled.visited).toHaveLength(48);
  expect(drilled.uncertain).toHaveLength(28);
  expect(limits(drilled.events)).toHaveLength(1);
});

test("keeps skipping rows of a kind without a detail link after the limit", async () => {
  const rows = times(24, (i) => kinded(i, i % 12));
  // The first kind has no detail link; its second row comes after the limit is reached.
  const drilled = await drill(rows, (links) => (links[1].name === word(0) ? 0.05 : 0.95), 1);
  expect(drilled.asked).toBe(10);
  expect(drilled.skipped).toBe(2);
  expect(drilled.visited).not.toContain(`/s/${word(12)}`);
});

test("logs no limit when 10 questions are enough", async () => {
  const drilled = await drill(
    times(20, (i) => kinded(i, i % 10)),
    () => 0.95,
    1,
  );
  expect(drilled).toMatchObject({ asked: 10, uncertain: [] });
  expect(limits(drilled.events)).toEqual([]);
  expect(drilled.events.find((event) => event.type === "drilldown_end")?.fields).not.toHaveProperty("link_limit_rows");
});
