/**
 * Deterministic catalog filtering (--service prefix, --runbook exact) and
 * 2-stage Jev noul ranking (--match) for large runbook catalogs.
 */

import type * as checkfile from "../storage/checkfile.ts";
import type { CatalogEntry } from "../storage/runbook/catalog.ts";

const CATALOG_BATCH = 40;
const CATALOG_CONCURRENCY = 4;
const SERVICE_STAGE_THRESHOLD = 10;
const SERVICE_TOP = 5;
const SERVICE_MAX = 10;
const SERVICE_MIN_SCORE = 0.3;
export const DEFAULT_TOP = 5;
export const DEFAULT_MIN_SCORE = 0.2;

export interface NoulItem {
  key: string;
  instructions: unknown;
}

export interface NoulScorer {
  scoreNoul(state: Record<string, unknown>, items: NoulItem[]): Promise<Map<string, number>>;
}

export interface CatalogFilterOptions {
  /** Prefix match on service name. */
  service?: string | null;
  /** Exact match on procedure full name ("service/name"), or procedure stem ("name") when paired with --service. */
  runbook?: string | null;
}

/** Deterministically filters catalog entries by service prefix and/or exact runbook name. */
export function filterCatalog(entries: CatalogEntry[], options: CatalogFilterOptions): CatalogEntry[] {
  const servicePrefix = options.service?.trim() || null;
  const runbookName = options.runbook?.trim() || null;

  let filtered = entries;
  if (servicePrefix) {
    filtered = filtered.filter((entry) => entry.service.startsWith(servicePrefix));
  }
  if (!runbookName) return filtered;

  const hasSlash = runbookName.includes("/");
  const matched: CatalogEntry[] = [];
  for (const entry of filtered) {
    const procedures = entry.procedures.filter((proc) =>
      hasSlash ? proc.name === runbookName : proc.name === `${entry.service}/${runbookName}`,
    );
    if (procedures.length) {
      matched.push({ ...entry, procedures });
    }
  }
  return matched;
}

/** Filters checkfile entries to match a service prefix (omitted when a specific --runbook is requested). */
export function filterCheckfiles(entries: checkfile.Listed[], options: CatalogFilterOptions): checkfile.Listed[] {
  if (options.runbook?.trim()) return [];
  const servicePrefix = options.service?.trim() || null;
  if (!servicePrefix) return entries;
  return entries.filter((entry) => {
    const firstSegment = entry.name.split("/")[0] ?? "";
    const runbookService = entry.file?.runbook?.split("/")[0] ?? "";
    return firstSegment.startsWith(servicePrefix) || runbookService.startsWith(servicePrefix);
  });
}

interface MatchedService {
  entry: CatalogEntry;
  score: number;
}

interface MatchedProcedure {
  service: string;
  entry: CatalogEntry;
  procedure: CatalogEntry["procedures"][number];
  score: number;
}

export interface CatalogMatchOptions {
  top?: number;
  minScore?: number;
  batchSize?: number;
  concurrency?: number;
  serviceStageThreshold?: number;
}

export interface CatalogMatchResult {
  query: string;
  stages: 1 | 2;
  calls: number;
  totalServices: number;
  totalProcedures: number;
  evaluatedServices: number;
  evaluatedProcedures: number;
  services: MatchedService[];
  procedures: MatchedProcedure[];
  strongMatch: boolean;
  /** A listed service without any runbook scored high enough: its facts are what there is to plan from. */
  factsMatch: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function scoreBatched(
  scorer: NoulScorer,
  state: Record<string, unknown>,
  items: NoulItem[],
  batchSize: number,
  concurrency: number,
): Promise<{ scores: Map<string, number>; calls: number }> {
  const batches = chunk(items, Math.max(1, batchSize));
  const scores = new Map<string, number>();
  if (!batches.length) return { scores, calls: 0 };

  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), batches.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < batches.length) {
      const idx = nextIndex++;
      const batch = batches[idx];
      const batchScores = await scorer.scoreNoul(state, batch);
      for (const [key, value] of batchScores) scores.set(key, value);
    }
  });
  await Promise.all(workers);
  return { scores, calls: batches.length };
}

function serviceInstructions(entry: CatalogEntry): Record<string, unknown> {
  const sampleGoals = entry.procedures
    .map((p) => (typeof p.goal === "string" ? p.goal : ""))
    .filter(Boolean)
    .slice(0, 5);
  return {
    task: "Judge whether this service is relevant to the user's request.",
    service: entry.service,
    description: entry.info?.description ?? "",
    base_url: entry.info?.base_url ?? "",
    ...(entry.info?.facts?.length ? { facts: entry.info.facts.slice(0, 5) } : {}),
    ...(sampleGoals.length ? { sample_goals: sampleGoals } : {}),
  };
}

function procedureInstructions(entry: CatalogEntry, proc: CatalogEntry["procedures"][number]): Record<string, unknown> {
  const paramList = Object.entries(proc.params).map(([k, v]) => (v ? `${k}: ${v}` : k));
  return {
    task: "Judge whether this runbook matches the user's request and can fulfill it.",
    runbook: proc.name,
    status: proc.status,
    goal: proc.goal,
    start_url: proc.start_url,
    ...(paramList.length ? { params: paramList } : {}),
    service: entry.service,
    service_description: entry.info?.description ?? "",
  };
}

function compareProcedures(a: MatchedProcedure, b: MatchedProcedure): number {
  if (b.score !== a.score) return b.score - a.score;
  const aApproved = a.procedure.status === "approved" ? 1 : 0;
  const bApproved = b.procedure.status === "approved" ? 1 : 0;
  if (bApproved !== aApproved) return bApproved - aApproved;
  return a.procedure.name.localeCompare(b.procedure.name);
}

/**
 * Ranks catalog runbooks against a user query using Jev's parallel `noul` primitive.
 * Uses 2-stage routing (Services -> Procedures) when the service count exceeds `serviceStageThreshold`.
 */
export async function matchCatalog(
  scorer: NoulScorer,
  entries: CatalogEntry[],
  query: string,
  options: CatalogMatchOptions = {},
): Promise<CatalogMatchResult> {
  const top = Math.max(1, options.top ?? DEFAULT_TOP);
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const batchSize = options.batchSize ?? CATALOG_BATCH;
  const concurrency = options.concurrency ?? CATALOG_CONCURRENCY;
  const serviceStageThreshold = options.serviceStageThreshold ?? SERVICE_STAGE_THRESHOLD;

  const totalServices = entries.length;
  const totalProcedures = entries.reduce((sum, e) => sum + e.procedures.length, 0);
  const state = { user_request: query };

  let calls = 0;
  let stages: 1 | 2 = 1;
  let candidateEntries = entries;
  let evaluatedServices = 0;
  let stage1Services: MatchedService[] = [];

  const scoreServices = async (scored: CatalogEntry[]): Promise<MatchedService[]> => {
    const items: NoulItem[] = scored.map((entry, i) => ({ key: `s_${i}`, instructions: serviceInstructions(entry) }));
    const res = await scoreBatched(scorer, state, items, batchSize, concurrency);
    calls += res.calls;
    return scored.map((entry, i) => ({ entry, score: res.scores.get(`s_${i}`) ?? 0 }));
  };

  if (entries.length > serviceStageThreshold) {
    stages = 2;
    evaluatedServices = entries.length;
    const rankedServices = (await scoreServices(entries)).sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.entry.service.localeCompare(b.entry.service),
    );

    const kept = rankedServices.filter((s, i) => i < SERVICE_TOP || (s.score >= SERVICE_MIN_SCORE && i < SERVICE_MAX));
    stage1Services = kept;
    candidateEntries = kept.map((s) => s.entry);
  } else {
    // A service without a runbook has no procedure to be found through, so it is scored itself.
    const bare = entries.filter((entry) => entry.info && !entry.procedures.length);
    stage1Services = (await scoreServices(bare)).filter((s) => s.score >= minScore);
  }

  const candidatePairs: { entry: CatalogEntry; procedure: CatalogEntry["procedures"][number] }[] = [];
  for (const entry of candidateEntries) {
    for (const procedure of entry.procedures) {
      candidatePairs.push({ entry, procedure });
    }
  }

  let procedures: MatchedProcedure[] = [];
  if (candidatePairs.length) {
    const procItems: NoulItem[] = candidatePairs.map(({ entry, procedure }, i) => ({
      key: `p_${i}`,
      instructions: procedureInstructions(entry, procedure),
    }));
    const res = await scoreBatched(scorer, state, procItems, batchSize, concurrency);
    calls += res.calls;
    procedures = candidatePairs
      .map(({ entry, procedure }, i) => ({
        service: entry.service,
        entry,
        procedure,
        score: res.scores.get(`p_${i}`) ?? 0,
      }))
      .sort(compareProcedures)
      .slice(0, top);
  }

  // Collect relevant services: stage-1 top services plus parent services of top procedures.
  const serviceMap = new Map<string, MatchedService>();
  for (const s of stage1Services) serviceMap.set(s.entry.service, s);
  for (const p of procedures) {
    const existing = serviceMap.get(p.service);
    if (!existing || p.score > existing.score) {
      serviceMap.set(p.service, { entry: p.entry, score: existing ? Math.max(existing.score, p.score) : p.score });
    }
  }
  const services = [...serviceMap.values()]
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.entry.service.localeCompare(b.entry.service)))
    .slice(0, Math.max(SERVICE_TOP, top));

  const strongMatch = procedures.length > 0 && procedures[0].score >= minScore;

  const factsMatch = services.some((s) => !s.entry.procedures.length && s.score >= minScore);

  return {
    query,
    stages,
    calls,
    totalServices,
    totalProcedures,
    evaluatedServices,
    evaluatedProcedures: candidatePairs.length,
    services,
    procedures,
    strongMatch,
    factsMatch,
  };
}
