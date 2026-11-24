/** url and title expectations. */

import { quote } from "../../core/format.ts";
import type { ExpectationHandler } from "../types.ts";

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export const urlHandler: ExpectationHandler = {
  kind: "url",
  parse: (rest, raw) => ({ kind: "url", subject: rest, expected: null, raw }),
  evaluate: ({ page }, item) => {
    const target = item.subject.startsWith("/") ? pathOf(String(page.url)) : String(page.url);
    const same = target === item.subject;
    return {
      verdict: same ? "PASS" : "FAIL",
      evidence: `${same ? "" : `expected ${quote(item.subject)} `}observed ${quote(target)}`,
    };
  },
};

export const titleHandler: ExpectationHandler = {
  kind: "title",
  parse: (rest, raw) => ({ kind: "title", subject: rest, expected: null, raw }),
  evaluate: ({ page }, item) => {
    const observed = String(page.title);
    const same = observed === item.subject;
    return {
      verdict: same ? "PASS" : "FAIL",
      evidence: `${same ? "" : `expected ${quote(item.subject)} `}observed ${quote(observed)}`,
    };
  },
};
