/**
 * `webhand check`: a read-only comparison of Claude's expectations with one observation of the page. Nothing here
 * touches the browser or a model. A negative result (not found, a different count) needs the whole page to have
 * been seen; otherwise it is INCONCLUSIVE, never FAIL, so a missed look is not read as a product defect.
 */

import { ExpectationError } from "../core/errors.ts";
import { quote } from "../core/format.ts";
import type { Page } from "../core/types.ts";
import { actionSpace } from "../policies/base.ts";
import { normalize, seenWhole } from "./helpers.ts";
import { countHandler } from "./kinds/count.ts";
import { checkedHandler, fieldHandler } from "./kinds/field.ts";
import { titleHandler, urlHandler } from "./kinds/page.ts";
import { noTextHandler, textHandler } from "./kinds/text.ts";
import { type Expectation, type ExpectationHandler, KINDS, type Kind, type Outcome } from "./types.ts";

export type { Expectation, Outcome };
export { ExpectationError, seenWhole };

const HANDLERS: ExpectationHandler[] = [
  textHandler,
  noTextHandler,
  fieldHandler,
  checkedHandler,
  countHandler,
  urlHandler,
  titleHandler,
];
const BY_KIND = new Map<Kind, ExpectationHandler>(HANDLERS.map((handler) => [handler.kind, handler]));

/** KIND:SUBJECT, or KIND:SUBJECT=VALUE for field, checked and count. */
export function parseExpectation(raw: string): Expectation {
  const at = raw.indexOf(":");
  const kind = (at < 0 ? raw : raw.slice(0, at)) as Kind;
  const handler = BY_KIND.get(kind);
  if (!handler) throw new ExpectationError(`Unknown expectation ${quote(raw)}. Kinds: ${KINDS.join(", ")}`);
  const rest = at < 0 ? "" : raw.slice(at + 1);
  if (!normalize(rest)) throw new ExpectationError(`Expectation ${quote(raw)} has nothing to check`);
  return handler.parse(rest, raw);
}

export function evaluate(page: Page, item: Expectation): Outcome {
  const handler = BY_KIND.get(item.kind) as ExpectationHandler;
  const [elements] = actionSpace(page.actions ?? []);
  return handler.evaluate({ page, whole: seenWhole(page), elements }, item);
}
