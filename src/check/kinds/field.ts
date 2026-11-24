/** field and checked expectations. */

import { ExpectationError } from "../../core/errors.ts";
import { quote } from "../../core/format.ts";
import { normalize, parseKeyValue } from "../helpers.ts";
import type { EvalContext, Expectation, ExpectationHandler, Outcome } from "../types.ts";

function evaluateControl(ctx: EvalContext, item: Expectation, key: "value" | "checked"): Outcome {
  const found = ctx.elements.filter((element) => normalize(String(element.label)) === item.subject && key in element);
  if (found.length === 0) {
    return { verdict: "INCONCLUSIVE", reason: "not_found", evidence: `no observed field ${quote(item.subject)}` };
  }
  if (found.length > 1) {
    const where = found.map((element) => `[${element.index}] ${quote(element[key])}`).join(", ");
    return { verdict: "INCONCLUSIVE", reason: "ambiguous", evidence: `${found.length} fields: ${where}` };
  }
  const [element] = found;
  const observed = String(element[key]);
  const same = observed === item.expected;
  return {
    verdict: same ? "PASS" : "FAIL",
    evidence: `${same ? "" : `expected ${quote(item.expected)} `}observed ${quote(observed)} (${element.role} [${element.index}])`,
  };
}

export const fieldHandler: ExpectationHandler = {
  kind: "field",
  parse: (rest, raw) => {
    const { subject, expected } = parseKeyValue("field", rest, raw);
    return { kind: "field", subject, expected, raw };
  },
  evaluate: (ctx, item) => evaluateControl(ctx, item, "value"),
};

export const checkedHandler: ExpectationHandler = {
  kind: "checked",
  parse: (rest, raw) => {
    const { subject, expected } = parseKeyValue("checked", rest, raw);
    if (expected !== "true" && expected !== "false") {
      throw new ExpectationError(`checked takes true or false, got ${quote(raw)}`);
    }
    return { kind: "checked", subject, expected, raw };
  },
  evaluate: (ctx, item) => evaluateControl(ctx, item, "checked"),
};
