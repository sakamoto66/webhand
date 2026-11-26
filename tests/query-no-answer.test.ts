/** `webhand query` must not report the start of the page as the answer when no block matched the question. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { deps, FAILED, OK } from "../src/commands/context.ts";
import { Decision, type Policy } from "../src/core/types.ts";
import * as session from "../src/storage/session.ts";
import { cli, readEvents, tmpPath } from "./helpers.ts";
import { isolate } from "./jev.ts";

/** Jev that reports DONE at once and finds no block that answers the question. */
function noMatchJev(asked: number[]): Policy {
  return {
    name: "stub",
    calls: [],
    config: () => ({}),
    async choose() {
      return new Decision("DONE");
    },
    async selectBlocks(_page: unknown, _plan: unknown, _query: string, blocks: unknown[]) {
      asked.push(blocks.length);
      return new Set<string>();
    },
  } as unknown as Policy;
}

describe("real Chrome CLI: query with no matching block", () => {
  let cleanup: () => Promise<void>;
  let log: string;
  let dir: string;

  beforeEach(() => {
    ({ cleanup, log } = isolate());
    dir = tmpPath();
  });

  afterEach(async () => {
    await cleanup();
  });

  const pageUrl = (paragraphs: string[]) => {
    const path = join(dir, "page.html");
    writeFileSync(path, `<title>Opening hours</title><main>${paragraphs.map((p) => `<p>${p}</p>`).join("")}</main>`);
    return pathToFileURL(path).href;
  };

  const query = (url: string) =>
    cli(
      "query",
      "--goal",
      "Find the refund policy",
      "--url",
      url,
      "--answer-for",
      "refund policy",
      "--chrome",
      "linux",
    );

  test("says there is no answer, finishes as blocked, and does not exit with success", async () => {
    const asked: number[] = [];
    deps.policy = () => noMatchJev(asked);
    const url = pageUrl(
      Array.from({ length: 6 }, (_, i) => `Branch ${i + 1} is open on weekdays. ${"Hours may vary. ".repeat(12)}`),
    );

    const result = await query(url);

    expect(asked[0]).toBeGreaterThan(1); // The selection really ran.
    expect(result.out).toContain(`QUERY NO ANSWER (${url}): no block of the page matched the question`);
    expect(result.out).not.toContain("QUERY ANSWER");
    expect(result.out).toContain("not an answer");
    expect(result.out).toContain("Branch 1 is open on weekdays.");
    expect(result.out).toContain("FINISHED status=blocked");
    expect(result.out).not.toContain("status=done");
    expect(result.code).toBe(FAILED);
    expect(session.load()).toBeNull();
    expect(readEvents(log).find((e) => e.type === "run_end")?.status).toBe("blocked");
  });

  test("a page of one block, with nothing to select from, is still the answer", async () => {
    const asked: number[] = [];
    deps.policy = () => noMatchJev(asked);

    const result = await query(pageUrl(["Open on weekdays."]));

    expect(asked).toEqual([]);
    expect(result.out).toContain("QUERY ANSWER");
    expect(result.out).toContain("Open on weekdays.");
    expect(result.out).toContain("FINISHED status=done");
    expect(result.code).toBe(OK);
  });
});
