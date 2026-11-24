/** Non-table extractors: list, link, fields, and text. */

import { ExtractError } from "../../core/errors.ts";
import type { ExtractedKind, Kind, KindExtractor, RawItem } from "../types.ts";

type SimpleKind = Exclude<Kind, "table">;

const SCHEMAS: Record<SimpleKind, { columns: string[]; values: (item: RawItem) => Record<string, string> }> = {
  list: {
    columns: ["text"],
    values: (item) => ({ text: String(item.text) }),
  },
  link: {
    columns: ["name", "href"],
    values: (item) => ({ name: String(item.name), href: String(item.href) }),
  },
  fields: {
    columns: ["label", "type", "value"],
    values: (item) => ({ label: String(item.label), type: String(item.type), value: String(item.value) }),
  },
  text: {
    columns: ["heading", "text"],
    values: (item) => ({ heading: String(item.heading), text: String(item.text) }),
  },
};

export function simpleExtractor(kind: SimpleKind): KindExtractor {
  const schema = SCHEMAS[kind];
  return (raw, options): ExtractedKind => {
    if (options.columns) throw new ExtractError("--columns is for tables");
    const records = raw.items.map((item) => ({
      source: `${item.region}, ${kind} ${item.at}`,
      values: schema.values(item),
    }));
    if (!records.length) {
      return {
        records: [],
        columns: schema.columns,
        missing: [],
        notes: [],
        inconclusive: { reason: "none", note: `no ${kind} found` },
      };
    }
    return { records, columns: schema.columns, missing: [], notes: [] };
  };
}
