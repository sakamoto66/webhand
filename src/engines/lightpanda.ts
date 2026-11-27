import { servedEngine } from "./served.ts";

export const lightpanda = servedEngine({
  id: "lightpanda",
  label: "Lightpanda",
  guardsDocuments: true,
  serve: { arguments: (port) => ["serve", "--host", "127.0.0.1", "--port", String(port)], compat: false },
});
