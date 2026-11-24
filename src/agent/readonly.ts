/**
 * Read-only sessions (`start --read-only`): what is refused before it runs. The snapshot marks each action it can
 * tell may change something (`change`: a submit of a form that is not a plain GET, a button outside
 * any form). Anything it cannot tell is not caught: this is a refusal of what webhand can classify, not a guarantee.
 */

import { quote } from "../core/format.ts";
import type { Action } from "../core/types.ts";

export interface ReadOnly {
  /** Names of buttons outside a form that Claude allowed (--allow-control only). */
  allow: string[];
}

const PASSIVE_KINDS = new Set(["tab", "scroll", "wait", "reveal", "hover"]);

/**
 * The session's read-only rule, or null. A button is allowed only by --allow-control: the --more control gets
 * no allowance of its own, so a person's approval (the permission prompt on a command with --allow-control)
 * is the one way to let a button outside a form be pressed.
 */
export function inForce(state: { read_only?: ReadOnly | null }): ReadOnly | null {
  return state.read_only ?? null;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Why a read-only session refuses this action; null when it may run. */
export function refusal(action: Action, readOnly: ReadOnly): string | null {
  const name = quote(action.label);
  if (action.kind === "upload") return `${name} attaches a file`;
  if (PASSIVE_KINDS.has(action.kind)) return null;
  if (action.change === "form") return `${name} submits a form that is not a plain GET`;
  if (action.change === "control") {
    const allowed = readOnly.allow.map(normalize);
    const label = normalize(String(action.label));
    if (allowed.includes(label)) return null;
    return `${name} is a button outside any form, so what it does is unknown; allow it with --allow-control only if it just shows more`;
  }
  return null;
}
