import { cloudflareEngine } from "./cloudflare.ts";

/** Cloudflare's own stateless browser for agents. It takes no keep_alive (Cloudflare: it cannot be combined), so its session closes after the default idle time. */
export const kitesurf = cloudflareEngine({
  id: "kitesurf",
  label: "Cloudflare Browser Run (Kitesurf)",
  query: "browser=kitesurf",
});
