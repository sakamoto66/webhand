/** Shared CLI option builders reused across multiple command definitions. */

import type { OptionSpec } from "../args.ts";
import { CHROMES } from "../engines/chrome.ts";
import { ENGINE_CHOICES } from "../engines/index.ts";
import * as runbook from "../storage/runbook/index.ts";
import * as session from "../storage/session.ts";

export function idOption(): OptionSpec {
  return {
    name: "id",
    type: "string",
    default: session.DEFAULT_ID,
    help: "Name of the session, to run several at once. Give the same --id to every command of one session",
  };
}

export function chromeOption(): OptionSpec {
  return {
    name: "chrome",
    type: "string",
    choices: [...CHROMES].sort(),
    default: process.env.WEBHAND_CHROME ?? "auto",
    help: "auto uses the Windows Chrome on WSL when it is reachable",
  };
}

export function engineOption(): OptionSpec {
  return {
    name: "engine",
    type: "string",
    choices: [...ENGINE_CHOICES],
    default: process.env.WEBHAND_ENGINE ?? "auto",
    help: "What runs the browser. auto (default) uses the headless shell when it is installed and the run needs no window or saved profile, else Chrome. headless-shell, lightpanda, obscura, browser-run and kitesurf have no window and no saved profile, and --chrome does not apply to them. browser-run runs on Cloudflare (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN; kitesurf is its stateless agent browser), so the pages it opens are sent there. Default: WEBHAND_ENGINE, else auto",
  };
}

export function viewOptions(): OptionSpec[] {
  return [
    {
      name: "focus",
      type: "string",
      multiple: true,
      metavar: "REGION",
      help: "A region to show first, such as form:予約",
    },
    { name: "skip", type: "string", multiple: true, metavar: "REGION", help: "A region to leave out" },
    {
      name: "read",
      type: "string",
      multiple: true,
      metavar: "KIND",
      choices: [...runbook.READ_KINDS, "none"],
      help: "Content to read beyond the viewport: outline, text, table, list, link, control, media; none clears it",
    },
  ];
}

export function compareOption(): OptionSpec {
  return {
    name: "compare",
    type: "string",
    metavar: "CRITERION",
    help: "Before acting, scroll through the whole list and find the item that best meets this; none clears it",
  };
}

export function collectOption(): OptionSpec {
  return {
    name: "collect",
    type: "string",
    metavar: "CONDITION",
    help: "First scroll through the whole list and collect every item that meets this, then stop; none clears it",
  };
}

export function allowControlOption(): OptionSpec {
  return {
    name: "allow-control",
    type: "string",
    multiple: true,
    metavar: "NAME",
    help: "With --read-only, a button outside a form that may be pressed (its name as the page shows it). Needs a person's approval",
  };
}

export function moreOption(): OptionSpec {
  return {
    name: "more",
    type: "string",
    metavar: "CONTROL",
    help: "With --compare or --collect, press this control when the list ends, such as Next page; none clears it",
  };
}

export function valueOption(help?: string): OptionSpec {
  return { name: "value", type: "string", multiple: true, metavar: "LABEL=VALUE", ...(help ? { help } : {}) };
}

export function fileOption(): OptionSpec {
  return {
    name: "file",
    type: "string",
    multiple: true,
    metavar: "LABEL=PATH",
    help: "A file Jev may upload (under the current directory)",
  };
}
