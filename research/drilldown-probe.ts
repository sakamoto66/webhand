/**
 * How often Jev answers drilldown's two questions correctly, on rows and field names written here, against what the
 * earlier code did (the first link of the row; a field name containing the word). Research only.
 *
 * Each case runs through drilldownScan with a browser that is only these rows and names, so the thresholds, the filter of
 * link addresses, and the fields taken without asking are the shipped ones. Reuse of an answer between rows, the page
 * reading, and the block selection are not measured.
 *
 * `node research/drilldown-probe.ts` calls no API: it prints the number of requests and the earlier code's score.
 * `node research/drilldown-probe.ts --run [--repeat N]` calls the paid Jev API (TYPESAFE_API_KEY). Ask first.
 */

import type { Recorder } from "../src/core/metrics.ts";
import type { ModelCall } from "../src/core/types.ts";
import type { Driver } from "../src/ipc/remote.ts";
import { JevPolicy } from "../src/policies/jev.ts";
import { drilldownScan, type FieldJudge, type LinkChooser } from "../src/scans/drilldown.ts";

const LIST = "https://shop.example/list";

/** [row text, links as [name, path], number of the item's detail link from 1, or 0 for none]. */
const LINKS: [string, [string, string][], number][] = [
  [
    "青いシャツ ¥1,200 出品者: 山田商店",
    [
      ["", "/sellers/12"],
      ["青いシャツ", "/items/881"],
    ],
    2,
  ],
  [
    "山田商店 青いシャツ ¥1,200",
    [
      ["山田商店", "/shops/yamada"],
      ["詳細", "/items/881"],
    ],
    2,
  ],
  [
    "Blue shirt in Tops $12",
    [
      ["Tops", "/category/tops"],
      ["Blue shirt", "/products/blue-shirt"],
    ],
    2,
  ],
  [
    "Circe Fleece Hannah Approved Edit",
    [
      ["Hannah", "/customer/edit/id/4"],
      ["Edit", "/review/edit/id/311"],
    ],
    2,
  ],
  [
    "#1042 Jane Doe Pending $80 View",
    [
      ["Jane Doe", "/customers/7"],
      ["View", "/orders/1042"],
    ],
    2,
  ],
  [
    "Fix login timeout bug opened by kim",
    [
      ["Fix login timeout", "/issues/52"],
      ["bug", "/labels/bug"],
      ["kim", "/users/kim"],
    ],
    1,
  ],
  [
    "kim commented on Dark mode",
    [
      ["kim", "/users/kim"],
      ["Dark mode", "/topics/dark-mode"],
    ],
    2,
  ],
  [
    "Wireless mouse ★4.5 (210) Add to cart",
    [
      ["", "/dp/B01"],
      ["(210)", "/dp/B01/reviews"],
      ["Add to cart", "/cart/add/B01"],
    ],
    1,
  ],
  [
    "Quarterly report.pdf 2 MB Download Share",
    [
      ["Download", "/files/9/download"],
      ["Share", "/files/9/share"],
      ["Quarterly report.pdf", "/files/9"],
    ],
    3,
  ],
  [
    "User alice admin Delete Edit",
    [
      ["Delete", "/users/3/delete"],
      ["Edit", "/users/3/edit"],
    ],
    2,
  ],
  [
    "新着 夏の旅行特集 2026-08-01 続きを読む",
    [
      ["新着", "/tags/new"],
      ["続きを読む", "/articles/summer"],
    ],
    2,
  ],
  [
    "Senior Engineer Acme Corp Remote",
    [
      ["Acme Corp", "/companies/acme"],
      ["Senior Engineer", "/jobs/301"],
    ],
    2,
  ],
  [
    "Hotel Flora Lisbon €90 Show on map",
    [
      ["Show on map", "/map"],
      ["Hotel Flora", "/hotels/flora"],
    ],
    2,
  ],
  [
    "Invoice INV-7 Paid Globex",
    [
      ["Globex", "/accounts/globex"],
      ["INV-7", "/invoices/7"],
    ],
    2,
  ],
  ["Sponsored: Try CloudHost today Visit", [["Visit", "/ads/click"]], 0],
  ["Total 42 items Export CSV", [["Export CSV", "/export.csv"]], 0],
  [
    "Posted in Gardening by lee",
    [
      ["Gardening", "/forums/gardening"],
      ["lee", "/users/lee"],
    ],
    0,
  ],
  ["Draft: Untitled Delete", [["Delete", "/drafts/4/delete"]], 0],
  [
    "2 3 4 Next",
    [
      ["2", "/items"],
      ["Next", "/items"],
    ],
    0,
  ],
  ["Red kettle €25", [["Red kettle", "/p/77"]], 1],
];

/** [field names on a page, words of --fields with the field name each means, or null for none]. */
const FIELDS: [string[], [string, string | null][]][] = [
  [
    ["商品名", "価格", "在庫数", "発売日"],
    [
      ["price", "価格"],
      ["stock", "在庫数"],
      ["color", null],
    ],
  ],
  [
    ["小計", "消費税", "合計金額", "支払方法"],
    [
      ["Total", "合計金額"],
      ["tax", "消費税"],
      ["shipping", null],
    ],
  ],
  [
    ["Subtotal", "Tax", "Grand Total", "Payment"],
    [
      ["合計", "Grand Total"],
      ["支払方法", "Payment"],
      ["送料", null],
    ],
  ],
  [
    ["List price", "Sale price", "SKU", "Qty"],
    [
      ["quantity", "Qty"],
      ["型番", "SKU"],
      ["list price", "List price"],
    ],
  ],
  [
    ["Title", "Summary of Review", "Rating", "Status", "Nickname"],
    [
      ["Review Title", "Title"],
      ["rating", "Rating"],
      ["author", "Nickname"],
    ],
  ],
  [
    ["作成日", "更新日", "担当者", "状態"],
    [
      ["created", "作成日"],
      ["assignee", "担当者"],
      ["priority", null],
    ],
  ],
  [
    ["Name", "E-mail", "Phone number", "Company"],
    [
      ["メール", "E-mail"],
      ["電話", "Phone number"],
      ["住所", null],
    ],
  ],
  [
    ["Check-in", "Check-out", "Guests", "Cancellation policy"],
    [
      ["arrival date", "Check-in"],
      ["人数", "Guests"],
      ["price", null],
    ],
  ],
  [
    ["Author", "Publisher", "ISBN-13", "Pages"],
    [
      ["著者", "Author"],
      ["page count", "Pages"],
      ["language", null],
    ],
  ],
  [
    ["最終ログイン", "登録日", "権限"],
    [
      ["role", "権限"],
      ["signed up", "登録日"],
      ["email", null],
    ],
  ],
];

const run = process.argv.includes("--run");
const at = process.argv.indexOf("--repeat");
const repeat = at < 0 ? 1 : Number(process.argv[at + 1]);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat takes a whole number of 1 or more");

const words = FIELDS.reduce((n, [, wanted]) => n + wanted.length, 0);
const firstRight = LINKS.filter(([, , answer]) => answer === 1).length;
const containsRight = FIELDS.reduce(
  (n, [labels, wanted]) =>
    n +
    wanted.filter(([word, answer]) => {
      const taken = labels.filter((label) => label.toLowerCase().includes(word.toLowerCase()));
      return answer === null ? !taken.length : taken.length === 1 && taken[0] === answer;
    }).length,
  0,
);

type Judge = LinkChooser & FieldJudge & { close?(): Promise<void> };

/** Answers nothing sure, so that a run without --run counts the requests drilldown would send. */
const offline: Judge = {
  calls: [],
  detailLink: async (_row, links) => ({ key: links[0].key, noul: 0 }),
  matchFields: async (wanted, labels) => new Map(wanted.map((word) => [word, { key: labels[0].key, noul: 0 }])),
  selectBlocks: async () => new Set(),
};

const jev = run ? new JevPolicy() : null;
const judge: Judge = jev ?? offline;
let requests = 0;
let wordsAsked = 0;
const counted: Judge = {
  calls: judge.calls,
  detailLink: (row, links) => {
    requests += 1;
    return judge.detailLink(row, links);
  },
  matchFields: (wanted, labels) => {
    requests += 1;
    wordsAsked += wanted.length;
    return judge.matchFields(wanted, labels);
  },
  selectBlocks: (...args) => judge.selectBlocks(...args),
};

const calls: ModelCall[] = [];
const recorder = {
  call: (call: ModelCall) => calls.push(call),
  event: (type: string, fields: Record<string, unknown>) => {
    if (run && type !== "drilldown_end") console.log(JSON.stringify({ type, ...fields }));
  },
} as unknown as Recorder;

/** One drilldown of one list row, whose detail page has these field names. */
async function scan(row: string, links: [string, string][], labels: string[], wanted: string[] | null) {
  let at = LIST;
  const found = {
    row,
    list: "",
    bare: false,
    links: links.map(([name, path], i) => ({ href: new URL(path, LIST).href, name, at: `a:${i + 1}` })),
  };
  const fields = Object.fromEntries(labels.map((label) => [label, `value of ${label}`]));
  const browser = {
    observe: async () => ({ url: LIST }),
    goto: async (url: string) => {
      at = url;
    },
    evaluate: async () => (at === LIST ? [found] : { url: at, title: "", fields }),
  } as unknown as Driver;
  const result = await drilldownScan(
    browser,
    null,
    { goal: "probe", steps: [], values: [] },
    // For the fields, --link-text takes the row's one link, so no link question is asked.
    { linkChooser: counted, fields: wanted, fieldJudge: counted, linkText: wanted ? "open" : null },
    recorder,
  );
  return { item: result.items[0], hrefs: found.links.map((link) => link.href) };
}

const score = { right: 0, unsure: 0, wrong: 0 };
const linkScore = { ...score };
const fieldScore = { ...score };
try {
  for (let round = 0; round < (run ? repeat : 1); round++) {
    for (const [row, links, answer] of LINKS) {
      const { item, hrefs } = await scan(row, links, [], null);
      const taken = item ? hrefs.indexOf(item.url) + 1 : 0;
      const verdict = item?.link_uncertain ? "unsure" : taken === answer ? "right" : "wrong";
      linkScore[verdict] += 1;
      if (run) console.log(JSON.stringify({ round, row, answer, taken, verdict }));
    }
    for (const [labels, wanted] of FIELDS) {
      const words = wanted.map(([word]) => word);
      const { item } = await scan("open", [["open", "/detail"]], labels, words);
      for (const [word, answer] of wanted) {
        const taken = item.field_labels?.[word] ?? null;
        const unsure = item.uncertain_fields?.some((u) => u.field === word);
        const verdict = unsure ? "unsure" : taken === answer ? "right" : "wrong";
        fieldScore[verdict] += 1;
        if (run) console.log(JSON.stringify({ round, word, answer, taken, verdict }));
      }
    }
  }
} finally {
  await jev?.close();
  console.log(`cases: ${LINKS.length} rows, ${words} words on ${FIELDS.length} pages`);
  // A run with --run may have stopped partway, so it reports what it sent and not a count a round.
  if (run) console.log(`requests sent: ${requests}`);
  else {
    console.log(`words taken without asking (equal to a field name): ${words - wordsAsked} a round`);
    console.log(`requests a round: ${requests}; ${repeat} round(s): ${requests * repeat}`);
  }
  console.log("(each request may be retried twice on 429, 503, or 529)");
  console.log(`earlier code: links ${firstRight}/${LINKS.length}, fields ${containsRight}/${words}`);
  if (run) {
    const tokens = calls.reduce((n, call) => n + (call.input_tokens ?? 0), 0);
    console.log(
      JSON.stringify({
        model: jev?.servedModel,
        answered: calls.length,
        input_tokens: tokens,
        links: linkScore,
        fields: fieldScore,
      }),
    );
  }
}
