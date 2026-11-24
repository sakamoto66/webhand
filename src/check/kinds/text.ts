/** text and no-text expectations. */

import { quote } from "../../core/format.ts";
import { clip, haystack, matchingLine, normalize, notVisible } from "../helpers.ts";
import type { ExpectationHandler } from "../types.ts";

export const textHandler: ExpectationHandler = {
  kind: "text",
  parse: (rest, raw) => ({ kind: "text", subject: normalize(rest), expected: null, raw }),
  evaluate: ({ page, whole }, item) => {
    if (haystack(page).includes(item.subject)) {
      return { verdict: "PASS", evidence: quote(clip(matchingLine(page, item.subject))) };
    }
    return whole ? { verdict: "FAIL", evidence: "not on the page" } : notVisible(quote(item.subject));
  },
};

export const noTextHandler: ExpectationHandler = {
  kind: "no-text",
  parse: (rest, raw) => ({ kind: "no-text", subject: normalize(rest), expected: null, raw }),
  evaluate: ({ page, whole }, item) => {
    if (haystack(page).includes(item.subject)) {
      return { verdict: "FAIL", evidence: `found: ${quote(clip(matchingLine(page, item.subject)))}` };
    }
    return whole ? { verdict: "PASS", evidence: "not on the page" } : notVisible(quote(item.subject));
  },
};
