import { servedEngine } from "./served.ts";

/** Obscura refuses loopback and private addresses unless told otherwise (its SSRF guard). */
export const obscura = servedEngine({
  id: "obscura",
  label: "Obscura",
  binaryVariable: "WEBHAND_OBSCURA",
  serve: {
    arguments(port) {
      const open = process.env.WEBHAND_OBSCURA_ALLOW_PRIVATE === "1" ? ["--allow-private-network"] : [];
      return ["serve", "--port", String(port), ...open];
    },
    compat: true,
  },
});
