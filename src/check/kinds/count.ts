/** count expectation: number of observed elements with a given role. */

import { ExpectationError } from "../../core/errors.ts";
import { quote } from "../../core/format.ts";
import { notVisible, parseKeyValue } from "../helpers.ts";
import type { ExpectationHandler } from "../types.ts";

export const countHandler: ExpectationHandler = {
  kind: "count",
  parse: (rest, raw) => {
    const { subject, expected } = parseKeyValue("count", rest, raw);
    if (!/^\d+$/.test(expected)) throw new ExpectationError(`count takes a whole number, got ${quote(raw)}`);
    return { kind: "count", subject, expected, raw };
  },
  evaluate: ({ whole, elements }, item) => {
    const count = elements.filter((element) => element.role === item.subject).length;
    if (!whole) return notVisible(`all ${quote(item.subject)} elements`);
    const same = String(count) === item.expected;
    return {
      verdict: same ? "PASS" : "FAIL",
      evidence: `${same ? "" : `expected ${item.expected} `}observed ${count}`,
    };
  },
};
