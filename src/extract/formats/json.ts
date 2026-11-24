/** JSON formatter for `webhand extract --format json`. */

import type { Extraction } from "../types.ts";

export function formatJson(extraction: Extraction): string {
  return JSON.stringify(
    { ...extraction, records: extraction.records.map((record) => ({ source: record.source, ...record.values })) },
    null,
    2,
  );
}
