/**
 * Releases a version with the local gh login: bump on release/X.Y.Z, pull request, every check, one
 * confirmation, merge, then a GitHub Release on the merge commit, which starts release.yml.
 *
 *   node scripts/release.ts X.Y.Z [--dry-run]
 *
 * Each run reads what already exists (Release, tag, pull request, branches) and continues from there,
 * so after a failure the same command is run again. Nothing is deleted or forced. --dry-run only reads.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

/** Everything that reaches outside the process, so that tests replace all of it. */
export interface Deps {
  /** `show` sends the command's output to the terminal instead of returning it. */
  run(command: string[], options?: { show?: boolean }): Result;
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/** The jobs of .github/workflows/check.yml. The ruleset requires only some of them; a release needs all. */
export const CHECKS = ["check", "package", "test", "verify-tasks"];

const POLL_MS = 15_000;
const CHECK_POLLS = 120; // 30 minutes
const MERGE_POLLS = 8;

/** What `npm version` and its "version" script change. */
const BUMPED = /^(package\.json|package-lock\.json|\.(claude|antigravity|codex)-plugin\/plugin\.json|skills\/.+\.md)$/;

interface Check {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  /** Commit statuses have `context` and `state` instead. */
  context?: string;
  state?: string;
}

interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  isCrossRepository: boolean;
  mergeCommit: { oid: string } | null;
}

const PR_FIELDS = "number,url,state,headRefOid,isCrossRepository,mergeCommit";

type Stage =
  | { at: "released"; url: string }
  | { at: "tagged"; sha: string }
  | { at: "merged"; pr: PullRequest; sha: string }
  | { at: "open"; pr: PullRequest }
  | { at: "pushed" }
  | { at: "committed" }
  | { at: "unstarted"; branch: boolean };

class Stop extends Error {}

function text(deps: Deps, command: string[]): string {
  const result = deps.run(command);
  if (result.status !== 0) {
    throw new Stop(`\`${command.join(" ")}\` failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** A command that changes something. It runs once: a failure stops the release, and a new run looks again. */
function change(deps: Deps, command: string[]): void {
  deps.log(`$ ${command.join(" ")}`);
  const result = deps.run(command, { show: true });
  if (result.status !== 0) throw new Stop(`\`${command.join(" ")}\` failed (exit ${result.status})`);
}

function names(version: string) {
  return { tag: `v${version}`, branch: `release/${version}` };
}

function newer(version: string, than: string): boolean {
  const [a, b] = [version, than].map((v) => v.split(".").map(Number));
  const i = a.findIndex((part, at) => part !== b[at]);
  return i >= 0 && a[i] > b[i];
}

function versionAt(deps: Deps, ref: string): string {
  const path = `repos/{owner}/{repo}/contents/package.json?ref=${ref}`;
  return JSON.parse(text(deps, ["gh", "api", path, "-H", "Accept: application/vnd.github.raw+json"])).version;
}

function expectVersion(deps: Deps, ref: string, version: string): void {
  const found = versionAt(deps, ref);
  if (found !== version) throw new Stop(`package.json at ${ref} has version ${found}, not ${version}`);
}

function releaseUrl(deps: Deps, tag: string): string | undefined {
  const result = deps.run(["gh", "release", "view", tag, "--json", "url,isDraft"]);
  if (result.status !== 0) {
    if (/release not found/i.test(result.stderr)) return undefined;
    throw new Stop(`could not look up the Release ${tag}: ${result.stderr.trim()}`);
  }
  const { url, isDraft } = JSON.parse(result.stdout);
  if (isDraft) throw new Stop(`${tag} is a draft Release (${url}). Publish or delete it first.`);
  return url;
}

function tagCommit(deps: Deps, tag: string): string | undefined {
  const ref = `refs/tags/${tag}`;
  const lines = text(deps, ["git", "ls-remote", "origin", ref, `${ref}^{}`])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  // An annotated tag lists the tag object and, with ^{}, the commit.
  return (lines.find(([, name]) => name.endsWith("^{}")) ?? lines[0])?.[0];
}

function onNpm(deps: Deps, version: string): boolean {
  const result = deps.run(["npm", "view", `webhand@${version}`, "version"]);
  if (result.status === 0) return result.stdout.trim() !== "";
  if (result.stderr.includes("E404")) return false;
  throw new Stop(`could not look up webhand@${version} on npm: ${result.stderr.trim()}`);
}

/** Pull requests from this repository's release branch into main. A fork's branch of the same name is not one. */
function pullRequests(deps: Deps, branch: string): PullRequest[] {
  const found: PullRequest[] = JSON.parse(
    text(deps, ["gh", "pr", "list", "--head", branch, "--base", "main", "--state", "all", "--json", PR_FIELDS]),
  );
  return found.filter((pr) => !pr.isCrossRepository);
}

function localCommit(deps: Deps, branch: string): string | undefined {
  const result = deps.run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function remoteCommit(deps: Deps, branch: string): string | undefined {
  return text(deps, ["git", "ls-remote", "origin", `refs/heads/${branch}`]).split("\t")[0] || undefined;
}

/** Merging or pushing must not leave out a local commit, or take in one that was never seen here. */
function expectSame(local: string | undefined, remote: string, branch: string): void {
  if (local && local !== remote) {
    throw new Stop(
      `the local ${branch} (${local}) differs from origin's (${remote}). Push or pull so that they match, ` +
        "or delete the local branch.",
    );
  }
}

function findStage(deps: Deps, version: string): Stage {
  const { tag, branch } = names(version);
  const url = releaseUrl(deps, tag);
  if (url) return { at: "released", url };

  const tagged = tagCommit(deps, tag);
  if (onNpm(deps, version)) {
    throw new Stop(`webhand@${version} is already on npm but there is no Release ${tag}. Use a new version.`);
  }
  const prs = pullRequests(deps, branch);
  const merged = prs.find((pr) => pr.state === "MERGED");
  if (merged) {
    const sha = merged.mergeCommit?.oid;
    if (!sha) throw new Stop(`${merged.url} is merged but GitHub does not report its merge commit yet.`);
    if (tagged && tagged !== sha) {
      throw new Stop(`the tag ${tag} points to ${tagged}, not to the merge commit ${sha} of ${merged.url}.`);
    }
    return tagged ? { at: "tagged", sha } : { at: "merged", pr: merged, sha };
  }
  if (tagged) throw new Stop(`the tag ${tag} already exists (${tagged}) without a merged ${branch} pull request.`);

  const local = localCommit(deps, branch);
  const remote = remoteCommit(deps, branch);
  const open = prs.find((pr) => pr.state === "OPEN");
  if (open) {
    expectSame(local, open.headRefOid, branch);
    return { at: "open", pr: open };
  }
  const closed = prs.find((pr) => pr.state === "CLOSED");
  if (closed && (local || remote)) {
    throw new Stop(`${closed.url} was closed without merging. Reopen it, or delete ${branch} here and on origin.`);
  }
  if (remote) {
    expectSame(local, remote, branch);
    return { at: "pushed" };
  }
  if (local && Number(text(deps, ["git", "rev-list", "--count", `origin/main..${branch}`])) > 0) {
    return { at: "committed" };
  }
  return { at: "unstarted", branch: local !== undefined };
}

function currentBranch(deps: Deps): string {
  return text(deps, ["git", "branch", "--show-current"]);
}

/**
 * The tree must be clean. The exception is a release branch whose commit failed (a check in the
 * pre-commit hook, for example): its uncommitted version bump is picked up again.
 */
function expectStartable(deps: Deps, version: string, branchExists: boolean): void {
  const { branch } = names(version);
  // Not trimmed as a whole: a line may start with a space. A rename lists "old -> new".
  const result = deps.run(["git", "status", "--porcelain"]);
  if (result.status !== 0) throw new Stop(`\`git status\` failed: ${result.stderr.trim()}`);
  const dirty = result.stdout.split("\n").filter(Boolean);
  const resuming = branchExists && currentBranch(deps) === branch;
  const unexpected = resuming ? dirty.filter((line) => !BUMPED.test(line.slice(3))) : dirty;
  if (unexpected.length > 0) {
    throw new Stop(`the working tree is not clean. Commit or move these away first:\n${unexpected.join("\n")}`);
  }
  const main = versionAt(deps, "main");
  if (!newer(version, main)) throw new Stop(`${version} is not newer than main's version ${main}`);
}

const SWITCH_BACK = "git switch <the branch you started on>";

function createCommands(version: string, branchExists: boolean, current: string): string[][] {
  const { branch } = names(version);
  const commands: string[][] = [];
  if (!branchExists) commands.push(["git", "switch", "--no-track", "-c", branch, "origin/main"]);
  else if (current !== branch) commands.push(["git", "switch", branch]);
  commands.push(
    ["npm", "version", version, "--no-git-tag-version", "--allow-same-version"],
    ["git", "add", "--update"],
    ["git", "commit", "-m", `chore: release ${version}`],
  );
  return commands;
}

function pushCommand(version: string): string[] {
  return ["git", "push", "--set-upstream", "origin", names(version).branch];
}

function prCommand(version: string): string[] {
  const { tag, branch } = names(version);
  const body = `Bumps the version to ${version}. Created by scripts/release.ts, which merges it and publishes ${tag}.`;
  return [
    ...["gh", "pr", "create", "--base", "main", "--head", branch],
    ...["--title", `chore: release ${version}`, "--body", body],
  ];
}

function mergeCommand(number: number | string, sha: string): string[] {
  return ["gh", "pr", "merge", String(number), "--merge", "--match-head-commit", sha];
}

function releaseCommand(version: string, target: string[]): string[] {
  const { tag } = names(version);
  return ["gh", "release", "create", tag, ...target, "--title", tag, "--generate-notes"];
}

/** The commands a run would still issue from this stage. */
function plan(deps: Deps, version: string, stage: Stage): string[] {
  const wait = `(wait for the checks: ${CHECKS.join(", ")})`;
  const ask = "(ask once before merging)";
  const quoted = (command: string[]) => command.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
  if (stage.at === "released") return [];
  if (stage.at === "tagged") return [quoted(releaseCommand(version, ["--verify-tag"]))];
  if (stage.at === "merged") return [quoted(releaseCommand(version, ["--target", stage.sha]))];
  const open = stage.at === "open" ? stage.pr : undefined;
  const steps = [
    wait,
    ask,
    quoted(mergeCommand(open?.number ?? "<number>", open?.headRefOid ?? "<head sha>")),
    quoted(releaseCommand(version, ["--target", "<merge commit sha>"])),
  ];
  if (stage.at === "open") return steps;
  steps.unshift(quoted(prCommand(version)));
  if (stage.at === "pushed") return steps;
  steps.unshift(quoted(pushCommand(version)));
  if (stage.at === "committed") return steps;
  const current = currentBranch(deps);
  const create = createCommands(version, stage.branch, current).map(quoted);
  const back = current === names(version).branch ? [] : [SWITCH_BACK];
  return [...create, steps[0], ...back, ...steps.slice(1)];
}

function describe(version: string, stage: Stage): string {
  const { tag, branch } = names(version);
  switch (stage.at) {
    case "released":
      return `the Release ${tag} exists: ${stage.url}`;
    case "tagged":
      return `the tag ${tag} is on the merge commit ${stage.sha}, without a Release`;
    case "merged":
      return `${stage.pr.url} is merged as ${stage.sha}; no Release yet`;
    case "open":
      return `${stage.pr.url} is open`;
    case "pushed":
      return `origin has ${branch}, without a pull request`;
    case "committed":
      return `the local ${branch} has the release commit, not pushed`;
    case "unstarted":
      return stage.branch ? `the local ${branch} exists without a commit` : "nothing exists yet";
  }
}

/** For a failure message: what a run leaves behind at this stage, and how to go on. */
function leftBehind(version: string, stage: Stage): string {
  const { branch } = names(version);
  const nothing = "no tag, Release, or npm publish";
  switch (stage.at) {
    case "unstarted":
      return stage.branch
        ? `the local ${branch}, possibly with an uncommitted version bump; ${nothing}. Stay on it to resume.`
        : `nothing on origin; ${nothing}.`;
    case "committed":
      return `the local ${branch} with the release commit; ${nothing}.`;
    case "pushed":
      return `${branch} on origin; ${nothing}.`;
    case "open":
      return (
        `the pull request ${stage.pr.url} and ${branch}; ${nothing}. For a failed check, rerun the job, ` +
        "or commit a fix to the branch and push it."
      );
    case "merged":
    case "tagged":
      return (
        `main has the version ${version} (${stage.sha}) but it is not published. Run again soon: ` +
        "the skills on main may already ask npm for it."
      );
    case "released":
      return `the Release ${stage.url}.`;
  }
}

function checkName(check: Check): string {
  return check.name ?? check.context ?? "?";
}

function checkState(check: Check): "pass" | "pending" | "fail" {
  if (check.state !== undefined) {
    if (check.state === "SUCCESS") return "pass";
    return check.state === "PENDING" || check.state === "EXPECTED" ? "pending" : "fail";
  }
  if (check.status !== "COMPLETED") return "pending";
  if (check.conclusion === "SUCCESS") return "pass";
  const optional = check.workflowName !== "check";
  return optional && (check.conclusion === "SKIPPED" || check.conclusion === "NEUTRAL") ? "pass" : "fail";
}

/** Right after a push GitHub lists no checks, or only some, so each expected one has to appear. */
async function waitForChecks(deps: Deps, pr: PullRequest): Promise<void> {
  let last = "";
  for (let poll = 0; poll < CHECK_POLLS; poll++) {
    if (poll > 0) await deps.sleep(POLL_MS);
    const view = JSON.parse(
      text(deps, ["gh", "pr", "view", String(pr.number), "--json", "state,headRefOid,statusCheckRollup"]),
    );
    if (view.state !== "OPEN") throw new Stop(`${pr.url} is ${view.state} now`);
    if (view.headRefOid !== pr.headRefOid) {
      throw new Stop(`the head of ${pr.url} changed from ${pr.headRefOid} to ${view.headRefOid}`);
    }
    const checks: Check[] = view.statusCheckRollup ?? [];
    const failed = checks.filter((check) => checkState(check) === "fail");
    if (failed.length > 0) throw new Stop(`failed checks: ${failed.map(checkName).join(", ")} (${pr.url})`);
    const waiting = [
      ...CHECKS.filter((name) => !checks.some((c) => c.name === name && c.workflowName === "check")),
      ...checks.filter((check) => checkState(check) === "pending").map(checkName),
    ];
    if (waiting.length === 0) return;
    const line = `waiting for: ${waiting.join(", ")}`;
    if (line !== last) deps.log(line);
    last = line;
  }
  throw new Stop(`the checks of ${pr.url} did not finish in ${(CHECK_POLLS * POLL_MS) / 60_000} minutes`);
}

async function mergeCommit(deps: Deps, pr: PullRequest): Promise<string> {
  for (let poll = 0; poll < MERGE_POLLS; poll++) {
    if (poll > 0) await deps.sleep(POLL_MS);
    const view = JSON.parse(text(deps, ["gh", "pr", "view", String(pr.number), "--json", "state,mergeCommit"]));
    if (view.state === "MERGED" && view.mergeCommit?.oid) return view.mergeCommit.oid;
  }
  throw new Stop(`GitHub does not report ${pr.url} as merged yet`);
}

/** Creates the branch, commits the bump, and goes back to the branch the run started on. */
function createCommit(deps: Deps, version: string, branchExists: boolean): () => void {
  const current = currentBranch(deps);
  const back = current
    ? ["git", "switch", current]
    : ["git", "switch", "--detach", text(deps, ["git", "rev-parse", "HEAD"])];
  for (const command of createCommands(version, branchExists, current)) change(deps, command);
  return () => {
    if (current !== names(version).branch) change(deps, back);
  };
}

/** Moves one stage forward. Returns undefined when the release is complete or the merge is declined. */
async function advance(deps: Deps, version: string, stage: Stage): Promise<Stage | undefined> {
  const { tag, branch } = names(version);
  switch (stage.at) {
    case "unstarted": {
      expectStartable(deps, version, stage.branch);
      const switchBack = createCommit(deps, version, stage.branch);
      change(deps, pushCommand(version));
      switchBack();
      return { at: "pushed" };
    }
    case "committed": {
      const { version: found } = JSON.parse(text(deps, ["git", "show", `${branch}:package.json`]));
      if (found !== version) throw new Stop(`the local ${branch} has version ${found}, not ${version}`);
      change(deps, pushCommand(version));
      return { at: "pushed" };
    }
    case "pushed": {
      expectVersion(deps, branch, version);
      change(deps, prCommand(version));
      const pr = pullRequests(deps, branch).find((found) => found.state === "OPEN");
      if (!pr) throw new Stop(`the new pull request for ${branch} is not listed yet`);
      return { at: "open", pr };
    }
    case "open": {
      const { pr } = stage;
      expectVersion(deps, pr.headRefOid, version);
      await waitForChecks(deps, pr);
      const files = text(deps, ["gh", "pr", "diff", String(pr.number), "--name-only"]);
      deps.log(`\nEvery check passed on ${pr.url}\nhead ${pr.headRefOid}, files:\n${files}\n`);
      const question = `Merge it into main and publish the Release ${tag}? [y/N] `;
      if (!(await deps.confirm(question))) {
        deps.log(`Not merged. ${pr.url} stays open; run the same command again to merge it.`);
        return undefined;
      }
      change(deps, mergeCommand(pr.number, pr.headRefOid));
      return { at: "merged", pr, sha: await mergeCommit(deps, pr) };
    }
    case "merged":
    case "tagged": {
      expectVersion(deps, stage.sha, version);
      const target = stage.at === "tagged" ? ["--verify-tag"] : ["--target", stage.sha];
      change(deps, releaseCommand(version, target));
      const url = releaseUrl(deps, tag);
      if (!url) throw new Stop(`the new Release ${tag} is not listed yet`);
      return { at: "released", url };
    }
    case "released":
      return undefined;
  }
}

function finish(deps: Deps, version: string, url: string): void {
  deps.log(`\nReleased: ${url}`);
  if (onNpm(deps, version)) {
    deps.log(`webhand@${version} is on npm.`);
    return;
  }
  const workflow = url.replace(/\/releases\/tag\/.*$/, "/actions/workflows/release.yml");
  deps.log(
    `Approve the npm environment now: ${workflow}\n` +
      `Until webhand@${version} is published, the skills on main may fail to run it with npx.`,
  );
}

const USAGE = "usage: node scripts/release.ts X.Y.Z [--dry-run]";

/** Returns the exit code. */
export async function release(args: string[], deps: Deps): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const [version, ...rest] = args.filter((arg) => arg !== "--dry-run");
  if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/.test(version ?? "") || rest.length > 0) {
    deps.log(USAGE);
    return 2;
  }
  let stage: Stage | undefined;
  try {
    text(deps, ["gh", "auth", "status"]);
    // A dry run leaves even the remote-tracking refs alone, so its branch comparison can be older.
    if (!dryRun) change(deps, ["git", "fetch", "origin"]);
    stage = findStage(deps, version);
    deps.log(`Now: ${describe(version, stage)}.`);
    if (dryRun) {
      if (stage.at === "unstarted") expectStartable(deps, version, stage.branch);
      const steps = plan(deps, version, stage);
      deps.log(steps.length > 0 ? `Dry run, nothing changed. A run would:\n${steps.join("\n")}` : "Nothing to do.");
      return 0;
    }
    while (stage.at !== "released") {
      const next: Stage | undefined = await advance(deps, version, stage);
      if (!next) return 1;
      stage = next;
    }
    finish(deps, version, stage.url);
    return 0;
  } catch (error) {
    deps.log(`\nRelease stopped: ${error instanceof Error ? error.message : String(error)}`);
    if (dryRun) return 1;
    // A failed command may still have taken effect, so look again before saying what is left.
    try {
      if (stage) stage = findStage(deps, version);
    } catch {
      // The last known stage is the best there is.
    }
    if (stage) deps.log(`Left: ${leftBehind(version, stage)}`);
    deps.log(`Next: fix the cause, then run \`node scripts/release.ts ${version}\` again; it continues from there.`);
    return 1;
  }
}

function terminalDeps(): Deps {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  return {
    run([command, ...args], options) {
      const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: options?.show ? "inherit" : "pipe" });
      if (result.error) return { status: 127, stdout: "", stderr: result.error.message };
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    async confirm(question) {
      if (!process.stdin.isTTY) return false;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(question);
      prompt.close();
      return /^y(es)?$/i.test(answer.trim());
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => void process.stdout.write(`${line}\n`),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await release(process.argv.slice(2), terminalDeps());
}
