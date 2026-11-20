import { cloudflareEngine } from "./cloudflare.ts";

/** The longest idle time Browser Run allows (20 minutes), so a session outlives the gaps between commands. */
const KEEP_ALIVE_MS = 1_200_000;

export const browserRun = cloudflareEngine({
  id: "browser-run",
  label: "Cloudflare Browser Run",
  query: `keep_alive=${KEEP_ALIVE_MS}`,
  notes: {
    start: "Browser Run runs on Cloudflare: the pages this run opens are sent to Cloudflare",
    auth: "the saved login was also sent to Cloudflare, into the Browser Run session",
  },
});
