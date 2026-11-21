/**
 * Read-only sessions (`start --read-only`): what is refused before it runs. The snapshot marks each action it can
 * tell may change something (`change`: a submit of a form that is not a plain GET, a button outside
 * any form). Anything it cannot tell is not caught: this is a refusal of what webhand can classify, not a guarantee.
 */

import { quote } from "./format.ts";
import type { Action } from "./types.ts";

export interface ReadOnly {
  /** Names of buttons outside a form that Claude allowed (--allow-control, and the --more control). */
  allow: string[];
}

/** The session's read-only rule with the control named by --more (Claude chose it to show more items), or null. */
export function inForce(state: { read_only?: ReadOnly | null; plan?: { more?: string | null } }): ReadOnly | null {
  if (!state.read_only) return null;
  return { allow: [...state.read_only.allow, ...(state.plan?.more ? [state.plan.more] : [])] };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Why a read-only session refuses this action; null when it may run. */
export function refusal(action: Action, readOnly: ReadOnly): string | null {
  const name = quote(action.label);
  if (action.kind === "upload") return `${name} attaches a file`;
  if (action.kind === "tab" || action.kind === "scroll" || action.kind === "wait" || action.kind === "reveal") {
    return null;
  }
  if (action.change === "form") return `${name} submits a form that is not a plain GET`;
  if (action.change === "control") {
    const allowed = readOnly.allow.map(normalize);
    const label = normalize(String(action.label));
    if (allowed.includes(label)) return null;
    return `${name} is a button outside any form, so what it does is unknown; allow it with --allow-control only if it just shows more`;
  }
  return null;
}
