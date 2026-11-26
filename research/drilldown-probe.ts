/**
 * How often Jev answers drilldown's two questions correctly, on rows and field names written here, against what the
 * earlier code did (the first link of the row; a field name containing the word). Research only.
 *
 * `node research/drilldown-probe.ts` calls no API: it prints the number of requests and the earlier code's score.
 * `node research/drilldown-probe.ts --run [--repeat N]` calls the paid Jev API (TYPESAFE_API_KEY). Ask first.
 */

import { JevPolicy } from "../src/policies/jev.ts";

/** The thresholds of src/scans/drilldown.ts. */
const NOUL_YES = 0.7;
const NOUL_NO = 0.3;

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
  ["Sponsored: Try CloudHost today Visit", [["Visit", "//ads.example/click"]], 0],
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
console.log(`cases: ${LINKS.length} rows, ${words} words on ${FIELDS.length} pages`);
console.log(`requests: ${(LINKS.length + FIELDS.length) * repeat} (each may be retried twice on 429, 503, or 529)`);

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
console.log(`earlier code: links ${firstRight}/${LINKS.length}, fields ${containsRight}/${words}`);

if (run) {
  const jev = new JevPolicy();
  const score = { right: 0, unsure: 0, wrong: 0 };
  const links = { ...score };
  const fields = { ...score };
  try {
    for (let round = 0; round < repeat; round++) {
      for (const [row, given, answer] of LINKS) {
        const views = given.map(([name, path], i) => ({ key: String(i + 1), name, path }));
        const { key, noul } = await jev.detailLink(row, views);
        const sure = noul >= NOUL_YES || noul <= NOUL_NO;
        const taken = noul >= NOUL_YES ? Number(key) : 0;
        links[!sure ? "unsure" : taken === answer ? "right" : "wrong"] += 1;
        console.log(JSON.stringify({ round, row, answer, key, noul }));
      }
      for (const [labels, wanted] of FIELDS) {
        const matches = await jev.matchFields(
          wanted.map(([word]) => word),
          labels.map((label, i) => ({ key: String(i + 1), label })),
        );
        for (const [word, answer] of wanted) {
          const { key, noul } = matches.get(word) as { key: string; noul: number };
          const sure = noul >= NOUL_YES || noul <= NOUL_NO;
          const taken = noul >= NOUL_YES ? labels[Number(key) - 1] : null;
          fields[!sure ? "unsure" : taken === answer ? "right" : "wrong"] += 1;
          console.log(JSON.stringify({ round, word, answer, label: labels[Number(key) - 1], noul }));
        }
      }
    }
  } finally {
    const tokens = jev.calls.reduce((n, call) => n + (call.input_tokens ?? 0), 0);
    console.log(
      JSON.stringify({ model: jev.servedModel, requests: jev.calls.length, input_tokens: tokens, links, fields }),
    );
    await jev.close();
  }
}
