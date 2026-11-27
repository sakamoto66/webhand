/** Tests for deterministic catalog filtering (--service, --runbook) and Jev noul ranking (--match). */

import { afterEach, expect, test, vi } from "vitest";
import { UsageError } from "../src/args.ts";
import { deps, OK } from "../src/commands/context.ts";
import { PolicyError } from "../src/core/types.ts";
import { type Fetch, JevPolicy, validateNoul } from "../src/policies/jev.ts";
import {
  filterCatalog,
  filterCheckfiles,
  matchCatalog,
  type NoulItem,
  type NoulScorer,
} from "../src/scans/catalog-match.ts";
import type * as checkfile from "../src/storage/checkfile.ts";
import type { CatalogEntry } from "../src/storage/runbook/catalog.ts";
import { cli, cliExit } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function makeEntry(service: string, procs: { stem: string; goal: string; status?: string }[]): CatalogEntry {
  return {
    service,
    info: {
      scope: "project",
      service,
      description: `${service} description`,
      base_url: `https://${service}.example.com`,
      allowed_domains: undefined,
      login: { required: false, url: null },
      pages: [],
      facts: [`fact for ${service}`],
    },
    procedures: procs.map((p) => ({
      name: `${service}/${p.stem}`,
      scope: "project",
      status: p.status ?? "approved",
      goal: p.goal,
      start_url: `https://${service}.example.com/${p.stem}`,
      params: { q: "query" },
      human_steps: 0,
      focus: [],
      skip: [],
    })),
  };
}

test("validateNoul accepts 0..1 numbers and rejects invalid values", () => {
  expect(validateNoul({ noul: 0 })).toBe(0);
  expect(validateNoul({ noul: 0.73 })).toBe(0.73);
  expect(validateNoul({ noul: 1 })).toBe(1);
  for (const bad of [null, {}, { noul: -0.01 }, { noul: 1.01 }, { noul: Number.NaN }, { noul: "0.5" }, []]) {
    expect(() => validateNoul(bad)).toThrow(PolicyError);
  }
});

test("JevPolicy.scoreNoul sends parallel noul questions and validates responses", async () => {
  vi.stubEnv("TYPESAFE_API_KEY", "test");
  const sent: unknown[] = [];
  const fetch: Fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return {
      status: 200,
      json: async () => ({
        model: "jev-test",
        usage: { input_tokens: 40, output_tokens: 8 },
        answers: {
          a: { type: "noul", noul: 0.92 },
          b: { type: "noul", noul: 0.14 },
        },
      }),
    };
  };
  const policy = new JevPolicy({ fetch });

  expect(await policy.scoreNoul({ user_request: "x" }, [])).toEqual(new Map());
  expect(sent).toHaveLength(0);

  const scores = await policy.scoreNoul({ user_request: "cancel hotel" }, [
    { key: "a", instructions: "cancel hotel booking" },
    { key: "b", instructions: "submit expense" },
  ]);
  expect(scores.get("a")).toBe(0.92);
  expect(scores.get("b")).toBe(0.14);
  expect(policy.calls).toHaveLength(1);
  expect(policy.calls[0].purpose).toBe("noul");
  expect(sent[0]).toMatchObject({
    state: { user_request: "cancel hotel" },
    questions: {
      a: { type: "noul", instructions: "cancel hotel booking" },
      b: { type: "noul", instructions: "submit expense" },
    },
  });
});

test("filterCatalog supports service prefix and exact runbook matching", () => {
  const entries = [
    makeEntry("aws-s3", [
      { stem: "upload", goal: "Upload a file" },
      { stem: "delete", goal: "Delete a file" },
    ]),
    makeEntry("aws-iam", [{ stem: "upload", goal: "Upload a policy" }]),
    makeEntry("gcp-storage", [{ stem: "upload", goal: "Upload to GCS" }]),
  ];

  // Service prefix match
  const aws = filterCatalog(entries, { service: "aws" });
  expect(aws.map((e) => e.service)).toEqual(["aws-s3", "aws-iam"]);

  // Full runbook exact match
  const exactFull = filterCatalog(entries, { runbook: "aws-s3/upload" });
  expect(exactFull).toHaveLength(1);
  expect(exactFull[0].procedures.map((p) => p.name)).toEqual(["aws-s3/upload"]);

  // Service prefix + stem exact match
  const prefixStem = filterCatalog(entries, { service: "aws-s3", runbook: "delete" });
  expect(prefixStem).toHaveLength(1);
  expect(prefixStem[0].procedures.map((p) => p.name)).toEqual(["aws-s3/delete"]);

  // Non-matching
  expect(filterCatalog(entries, { service: "azure" })).toEqual([]);
  expect(filterCatalog(entries, { runbook: "aws-s3/nonexistent" })).toEqual([]);
});

test("filterCheckfiles filters by service prefix and omits on --runbook", () => {
  const checks = [
    { name: "aws-s3/smoke", file: null, error: "err" },
    { name: "gcp/smoke", file: null, error: "err" },
  ] as checkfile.Listed[];
  expect(filterCheckfiles(checks, { service: "aws" }).map((c) => c.name)).toEqual(["aws-s3/smoke"]);
  expect(filterCheckfiles(checks, { service: "aws", runbook: "aws-s3/upload" })).toEqual([]);
  expect(filterCheckfiles(checks, {})).toHaveLength(2);
});

test("matchCatalog 1-stage ranks procedures across batches with deterministic tie-breaking", async () => {
  const entries = [
    makeEntry("travel", [
      { stem: "cancel", goal: "Cancel hotel booking", status: "approved" },
      { stem: "cancel_draft", goal: "Cancel hotel booking draft", status: "draft" },
      { stem: "change", goal: "Change hotel dates", status: "approved" },
    ]),
    makeEntry("expense", [{ stem: "claim", goal: "Submit expense", status: "approved" }]),
  ];

  const calls: NoulItem[][] = [];
  const scorer: NoulScorer = {
    async scoreNoul(_state, items) {
      calls.push(items);
      const out = new Map<string, number>();
      for (const item of items) {
        const name = String((item.instructions as Record<string, unknown>).runbook);
        if (name.includes("cancel")) out.set(item.key, 0.9);
        else if (name.includes("change")) out.set(item.key, 0.4);
        else out.set(item.key, 0.05);
      }
      return out;
    },
  };

  const result = await matchCatalog(scorer, entries, "cancel my hotel", { top: 3, batchSize: 2, concurrency: 2 });
  expect(result.stages).toBe(1);
  expect(result.calls).toBe(2);
  expect(calls.map((c) => c.length)).toEqual([2, 2]);
  expect(result.strongMatch).toBe(true);
  // Approved wins tie over draft at identical 0.9 score
  expect(result.procedures.map((p) => p.procedure.name)).toEqual([
    "travel/cancel",
    "travel/cancel_draft",
    "travel/change",
  ]);
});

test("matchCatalog 2-stage narrows services before scoring procedures", async () => {
  const entries = Array.from({ length: 15 }, (_, i) =>
    makeEntry(`svc-${String(i).padStart(2, "0")}`, [
      { stem: "a", goal: `Goal A for ${i}` },
      { stem: "b", goal: `Goal B for ${i}` },
    ]),
  );

  const scorer: NoulScorer = {
    async scoreNoul(_state, items) {
      const out = new Map<string, number>();
      for (const item of items) {
        const inst = item.instructions as Record<string, unknown>;
        if (item.key.startsWith("s_")) {
          out.set(item.key, inst.service === "svc-12" ? 0.95 : 0.1);
        } else {
          out.set(item.key, inst.runbook === "svc-12/b" ? 0.97 : 0.2);
        }
      }
      return out;
    },
  };

  const result = await matchCatalog(scorer, entries, "target svc-12 b", {
    top: 2,
    serviceStageThreshold: 10,
    batchSize: 10,
  });
  expect(result.stages).toBe(2);
  expect(result.evaluatedServices).toBe(15);
  // Top 5 services kept -> 5 * 2 = 10 procedures evaluated instead of 30
  expect(result.evaluatedProcedures).toBe(10);
  expect(result.totalProcedures).toBe(30);
  expect(result.procedures[0].procedure.name).toBe("svc-12/b");
  expect(result.procedures[0].score).toBe(0.97);
});

test("catalog CLI supports deterministic --service / --runbook and Jev --match", async () => {
  // Deterministic prefix filter (no Jev call)
  const svcRes = await cli("catalog", "--chrome", "linux", "--service", "hotel");
  expect(svcRes.code).toBe(OK);
  expect(svcRes.out).toContain('FILTER service prefix="hotel"');
  expect(svcRes.out).toContain("SERVICE hotel");

  // Deterministic exact runbook match
  const rbRes = await cli("catalog", "--chrome", "linux", "--runbook", "hotel-demo/search");
  expect(rbRes.code).toBe(OK);
  expect(rbRes.out).toContain('FILTER runbook="hotel-demo/search"');

  // Conflict: --runbook and --match together
  await expect(cli("catalog", "--runbook", "a/b", "--match", "find")).rejects.toThrow(UsageError);

  // Validation errors
  const badTop = await cliExit("catalog", "--chrome", "linux", "--match", "x", "--top", "0");
  expect(badTop).toContain("--top must be at least 1");
  const badMin = await cliExit("catalog", "--chrome", "linux", "--match", "x", "--min-score", "1.5");
  expect(badMin).toContain("--min-score must be between 0 and 1");

  // --service + --match combined with stubbed policy
  vi.spyOn(deps, "policy").mockReturnValue({
    name: "stub",
    calls: [],
    config: () => ({}),
    choose: async () => {
      throw new Error("unused");
    },
    scoreNoul: async (_state, items) => new Map(items.map((item, idx) => [item.key, idx === 0 ? 0.88 : 0.12])),
  });
  const matchRes = await cli(
    "catalog",
    "--chrome",
    "linux",
    "--service",
    "hotel",
    "--match",
    "find a hotel",
    "--top",
    "2",
  );
  expect(matchRes.code).toBe(OK);
  expect(matchRes.out).toContain('FILTER service prefix="hotel"');
  expect(matchRes.out).toContain('MATCH "find a hotel"');
  expect(matchRes.out).toContain("[score=0.88]");

  // Low score triggers NO STRONG MATCH warning
  vi.spyOn(deps, "policy").mockReturnValue({
    name: "stub",
    calls: [],
    config: () => ({}),
    choose: async () => {
      throw new Error("unused");
    },
    scoreNoul: async (_state, items) => new Map(items.map((item) => [item.key, 0.05])),
  });
  const lowRes = await cli(
    "catalog",
    "--chrome",
    "linux",
    "--service",
    "hotel",
    "--match",
    "unrelated",
    "--min-score",
    "0.5",
  );
  expect(lowRes.code).toBe(OK);
  expect(lowRes.out).toContain("NO STRONG MATCH");
});

test("matchCatalog lists a relevant service that has no runbook, with few services", async () => {
  const entries = [
    makeEntry("travel", [{ stem: "cancel", goal: "Cancel hotel booking" }]),
    makeEntry("checkout", []),
    makeEntry("unrelated", []),
  ];
  const scorer: NoulScorer = {
    async scoreNoul(_state, items) {
      return new Map(
        items.map((item) => {
          const inst = item.instructions as Record<string, unknown>;
          return [item.key, inst.service === "checkout" ? 0.9 : 0.05];
        }),
      );
    },
  };

  const result = await matchCatalog(scorer, entries, "place the order");
  expect(result.stages).toBe(1);
  expect(result.strongMatch).toBe(false);
  expect(result.factsMatch).toBe(true);
  expect(result.services.map((s) => s.entry.service)).toContain("checkout");
  expect(result.services.map((s) => s.entry.service)).not.toContain("unrelated");
});
