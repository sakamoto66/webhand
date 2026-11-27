/** scripts/release.ts against a fake repository: no real git, gh, or npm command runs here. */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CHECKS, type Deps, type Result, release } from "../scripts/release.ts";

const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom", status = 1): Result => ({ status, stdout: "", stderr });

const passed = CHECKS.map((name) => ({ name, workflowName: "check", status: "COMPLETED", conclusion: "SUCCESS" }));
const URL = "https://github.com/o/webhand/releases/tag/v0.8.0";
const PR_URL = "https://github.com/o/webhand/pull/7";
const BRANCH = "release/0.8.0";

interface Pr {
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  isCrossRepository?: boolean;
}

/** The state that the commands read and change. */
class Repo {
  current = "main";
  dirty: string[] = [];
  main = "0.7.0";
  local?: { sha: string; ahead: number };
  remote?: string;
  pr?: Pr;
  tag?: string;
  released = false;
  npm = false;
  answer = true;
  /** One rollup per poll; the last one stays. */
  rollups: object[][] = [passed];
  /** Commands (by prefix) that fail, once each. */
  failing: string[] = [];
  writes: string[] = [];
  logs: string[] = [];
  questions: string[] = [];

  deps: Deps = {
    run: (command) => this.run(command),
    confirm: async (question) => {
      this.questions.push(question);
      return this.answer;
    },
    sleep: async () => {},
    log: (line) => void this.logs.push(line),
  };

  get output() {
    return this.logs.join("\n");
  }

  run(command: string[]): Result {
    const line = command.join(" ");
    const read = this.read(line);
    if (read) return read;
    // Everything else changes something and has to be listed in write().
    this.writes.push(line);
    const at = this.failing.findIndex((prefix) => line.startsWith(prefix));
    if (at >= 0) {
      this.failing.splice(at, 1);
      return fail();
    }
    this.write(line);
    return ok();
  }

  private read(line: string): Result | undefined {
    const starts = (prefix: string) => line.startsWith(prefix);
    if (line === "gh auth status") return ok();
    if (starts("gh release view")) {
      return this.released ? ok(JSON.stringify({ url: URL, isDraft: false })) : fail("release not found");
    }
    if (starts("git ls-remote origin refs/tags/")) return ok(this.tag ? `${this.tag}\trefs/tags/v0.8.0\n` : "");
    if (starts("git ls-remote origin refs/heads/")) {
      return ok(this.remote ? `${this.remote}\trefs/heads/${BRANCH}\n` : "");
    }
    if (starts("npm view")) return this.npm ? ok("0.8.0\n") : fail("npm error code E404");
    if (starts("gh pr list")) {
      const pr = this.pr && {
        number: 7,
        url: PR_URL,
        isCrossRepository: false,
        mergeCommit: this.pr.state === "MERGED" ? { oid: "m1" } : null,
        ...this.pr,
      };
      return ok(JSON.stringify(pr ? [pr] : []));
    }
    if (starts("git rev-parse --verify")) return this.local ? ok(`${this.local.sha}\n`) : fail("", 1);
    if (starts("git rev-list --count")) return ok(`${this.local?.ahead ?? 0}\n`);
    if (line === "git branch --show-current") return ok(`${this.current}\n`);
    if (line === "git status --porcelain") return ok(this.dirty.map((entry) => `${entry}\n`).join(""));
    if (starts("git show ")) return ok(JSON.stringify({ version: "0.8.0" }));
    if (starts("gh api")) {
      return ok(JSON.stringify({ version: line.includes("ref=main ") ? this.main : "0.8.0" }));
    }
    if (starts("gh pr view") && line.endsWith("statusCheckRollup")) {
      const statusCheckRollup = this.rollups.length > 1 ? this.rollups.shift() : this.rollups[0];
      return ok(JSON.stringify({ state: this.pr?.state, headRefOid: this.pr?.headRefOid, statusCheckRollup }));
    }
    if (starts("gh pr view")) return ok(JSON.stringify({ state: this.pr?.state, mergeCommit: { oid: "m1" } }));
    if (starts("gh pr diff")) return ok("package.json\n");
    return undefined;
  }

  private write(line: string): void {
    if (line === "git fetch origin") return;
    if (line === `git switch --no-track -c ${BRANCH} origin/main`) {
      this.local = { sha: "base", ahead: 0 };
      this.current = BRANCH;
    } else if (line.startsWith("git switch ")) this.current = line.slice("git switch ".length);
    else if (line.startsWith("npm version 0.8.0 --no-git-tag-version")) this.dirty = [" M package.json"];
    else if (line === "git add --update") return;
    else if (line === "git commit -m chore: release 0.8.0") {
      this.local = { sha: "c1", ahead: 1 };
      this.dirty = [];
    } else if (line === `git push --set-upstream origin ${BRANCH}`) this.remote = this.local?.sha;
    else if (line.startsWith("gh pr create")) this.pr = { state: "OPEN", headRefOid: this.remote ?? "" };
    else if (line === `gh pr merge 7 --merge --match-head-commit ${this.pr?.headRefOid}`) {
      if (this.pr) this.pr.state = "MERGED";
    } else if (line.startsWith("gh release create v0.8.0 ")) {
      this.tag = "m1";
      this.released = true;
    } else throw new Error(`unexpected command: ${line}`);
  }

  /** The writes after the fetch, cut to their first words. */
  steps(): string[] {
    return this.writes.slice(1).map((line) => line.split(" ").slice(0, 3).join(" "));
  }
}

function repo(state: Partial<Repo> = {}): Repo {
  return Object.assign(new Repo(), state);
}

const pushed = { local: { sha: "c1", ahead: 1 }, remote: "c1" };
const opened = (): Partial<Repo> => ({ ...pushed, pr: { state: "OPEN", headRefOid: "c1" } });

const ALL_STEPS = [
  "git switch --no-track",
  "npm version 0.8.0",
  "git add --update",
  "git commit -m",
  "git push --set-upstream",
  "git switch main",
  "gh pr create",
  "gh pr merge",
  "gh release create",
];

describe("a release from the start", () => {
  test("runs every step once, asks once, and releases the merge commit", async () => {
    const r = repo();
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps()).toEqual(ALL_STEPS);
    expect(r.writes).toContain("gh pr merge 7 --merge --match-head-commit c1");
    expect(r.writes.at(-1)).toBe("gh release create v0.8.0 --target m1 --title v0.8.0 --generate-notes");
    expect(r.questions).toHaveLength(1);
    expect(r.current).toBe("main");
    expect(r.output).toContain("Approve the npm environment now: https://github.com/o/webhand/actions/workflows/");
  });

  test("does not merge without a yes, and a second run does", async () => {
    const r = repo({ answer: false });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.pr?.state).toBe("OPEN");
    expect(r.steps().at(-1)).toBe("gh pr create");
    r.answer = true;
    r.writes = [];
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps()).toEqual(["gh pr merge", "gh release create"]);
  });

  test.each([
    ["a dirty tree", { dirty: ["?? notes.txt"] }, "not clean"],
    ["a version that main already has", { main: "0.8.0" }, "not newer"],
    ["a version older than main's", { main: "0.10.0" }, "not newer"],
    ["a version on npm", { npm: true }, "already on npm"],
    ["a tag without a pull request", { tag: "x1" }, "already exists"],
  ])("stops on %s before changing anything", async (_, state, message) => {
    const r = repo(state);
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
    expect(r.output).toContain(message);
  });

  test("stops when gh is not logged in, before even fetching", async () => {
    const r = repo();
    r.deps.run = () => fail("not logged in");
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.output).toContain("not logged in");
  });

  test.each([[[]], [["v0.8.0"]], [["0.8"]], [["0.8.0-rc.1"]], [["0.8.0", "--yes"]]])(
    "rejects the arguments %j",
    async (args) => {
      const r = repo();
      expect(await release(args, r.deps)).toBe(2);
      expect(r.writes).toEqual([]);
    },
  );

  test("a lookup that fails for another reason than 'not found' stops the run", async () => {
    const r = repo();
    const run = r.deps.run;
    r.deps.run = (command) => (command[0] === "npm" ? fail("ETIMEDOUT") : run(command));
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
  });
});

describe("checks", () => {
  const running = { name: "test", workflowName: "check", status: "IN_PROGRESS", conclusion: "" };

  test("waits while none or only some of the expected checks are listed, or one is still running", async () => {
    const some = passed.filter((c) => c.name !== "verify-tasks");
    const r = repo({
      ...opened(),
      rollups: [[], some, [...passed.filter((c) => c.name !== "test"), running], passed],
    });
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.rollups).toEqual([passed]);
    expect(r.output).toContain("waiting for: check, package, test, verify-tasks");
    expect(r.output).toContain("waiting for: verify-tasks");
    expect(r.output).toContain("waiting for: test");
  });

  test("another workflow's job of the same name does not count", async () => {
    const other = passed.map((c) => (c.name === "package" ? { ...c, workflowName: "other" } : c));
    const r = repo({ ...opened(), rollups: [other] });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.output).toContain("did not finish");
    expect(r.steps()).toEqual([]);
  });

  test.each([
    ["a check the ruleset does not require", { ...passed[3], conclusion: "FAILURE" }],
    ["a skipped job of the check workflow", { ...passed[3], conclusion: "SKIPPED" }],
    ["a commit status", { context: "verify-tasks", state: "ERROR" }],
  ])("stops on %s", async (_, bad) => {
    const r = repo({ ...opened(), rollups: [[...passed.slice(0, 3), bad]] });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
    expect(r.questions).toEqual([]);
    expect(r.output).toContain("failed checks: verify-tasks");
    expect(r.output).toContain(`Left: the pull request ${PR_URL}`);
    expect(r.output).toContain("run `node scripts/release.ts 0.8.0` again");
  });

  test("a skipped check of another workflow passes", async () => {
    const skipped = { name: "scan", workflowName: "other", status: "COMPLETED", conclusion: "SKIPPED" };
    expect(await release(["0.8.0"], repo({ ...opened(), rollups: [[...passed, skipped]] }).deps)).toBe(0);
  });

  test("the expected checks are the jobs of check.yml", () => {
    const jobs = readFileSync(".github/workflows/check.yml", "utf8").split(/^jobs:$/m)[1];
    expect([...jobs.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1])).toEqual(CHECKS);
  });
});

describe("running again after a failure", () => {
  test.each(ALL_STEPS.filter((step) => step !== "git switch main"))("continues after %s fails", async (step) => {
    const r = repo({ failing: [step] });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.output).toContain("Left: ");
    expect(r.output).toContain("Next: ");
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.released).toBe(true);
    // A change that succeeded is not made again.
    for (const once of ["gh pr create", "gh pr merge", "gh release create"]) {
      expect(r.steps().filter((s) => s === once).length, once).toBe(once === step ? 2 : 1);
    }
  });

  test("picks up the uncommitted bump after a failed commit", async () => {
    const r = repo({ failing: ["git commit"] });
    await release(["0.8.0"], r.deps);
    expect(r.current).toBe(BRANCH);
    r.writes = [];
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps().slice(0, 2)).toEqual(["npm version 0.8.0", "git add --update"]);
  });

  test("does not take another change into the resumed commit", async () => {
    const r = repo({ current: BRANCH, local: { sha: "base", ahead: 0 }, dirty: [" M package.json", " M src/cli.ts"] });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
    expect(r.output).toContain("src/cli.ts");
    expect(r.output).not.toContain("\n M package.json");
  });

  test.each<[string, Partial<Repo>, string[]]>([
    ["a commit not pushed", { local: { sha: "c1", ahead: 1 } }, ["git push --set-upstream", "gh pr create"]],
    ["a branch without a pull request", pushed, ["gh pr create"]],
    ["an open pull request", opened(), []],
  ])("continues from %s", async (_, state, first) => {
    const r = repo(state);
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps()).toEqual([...first, "gh pr merge", "gh release create"]);
  });

  test("releases a pull request that is already merged, without asking again", async () => {
    const r = repo({ pr: { state: "MERGED", headRefOid: "c1" } });
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps()).toEqual(["gh release create"]);
    expect(r.questions).toEqual([]);
  });

  test("says that main is unpublished when the Release fails", async () => {
    const r = repo({ pr: { state: "MERGED", headRefOid: "c1" }, failing: ["gh release create"] });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.output).toContain("main has the version 0.8.0 (m1) but it is not published");
  });

  test("reports a merge that took effect although the command failed", async () => {
    const r = repo(opened());
    const run = r.deps.run;
    r.deps.run = (command) => {
      const result = run(command);
      return command[2] === "merge" ? fail() : result;
    };
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.output).toContain("it is not published");
  });

  test("uses the tag that is already on the merge commit", async () => {
    const r = repo({ pr: { state: "MERGED", headRefOid: "c1" }, tag: "m1" });
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.writes.at(-1)).toContain("--verify-tag");
  });

  test("refuses a tag on another commit", async () => {
    const r = repo({ pr: { state: "MERGED", headRefOid: "c1" }, tag: "x1" });
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
  });

  test("does nothing once released", async () => {
    const r = repo({ released: true, npm: true, tag: "m1" });
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps()).toEqual([]);
    expect(r.output).toContain("webhand@0.8.0 is on npm");
  });

  test.each<[string, Partial<Repo>, string]>([
    ["an unpushed local commit", { ...opened(), local: { sha: "c2", ahead: 2 } }, "differs from origin's"],
    ["a closed pull request", { ...pushed, pr: { state: "CLOSED", headRefOid: "c1" } }, "closed without merging"],
  ])("stops on %s", async (_, state, message) => {
    const r = repo(state);
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
    expect(r.output).toContain(message);
  });

  test("ignores a fork's pull request from a branch of the same name", async () => {
    const r = repo({ pr: { state: "OPEN", headRefOid: "evil", isCrossRepository: true } });
    expect(await release(["0.8.0"], r.deps)).toBe(0);
    expect(r.steps()).toEqual(ALL_STEPS);
    expect(r.writes.join("\n")).not.toContain("evil");
  });

  test("does not merge a head that moved while waiting", async () => {
    const r = repo(opened());
    const run = r.deps.run;
    r.deps.run = (command) => {
      if (command.at(-1)?.endsWith("statusCheckRollup") && r.pr) r.pr.headRefOid = "c2";
      return run(command);
    };
    expect(await release(["0.8.0"], r.deps)).toBe(1);
    expect(r.steps()).toEqual([]);
  });
});

describe("--dry-run", () => {
  test.each<[string, Partial<Repo>, string]>([
    ["from the start", {}, "git switch --no-track -c release/0.8.0 origin/main"],
    ["with a commit", { local: { sha: "c1", ahead: 1 } }, "git push --set-upstream"],
    ["with a pushed branch", pushed, "gh pr create"],
    ["with an open pull request", opened(), "gh pr merge 7 --merge --match-head-commit c1"],
    ["after the merge", { pr: { state: "MERGED", headRefOid: "c1" } }, "gh release create v0.8.0 --target m1"],
    ["with a tag", { pr: { state: "MERGED", headRefOid: "c1" }, tag: "m1" }, "--verify-tag"],
    ["after the release", { released: true }, "Nothing to do."],
  ])("%s changes nothing and lists what is left", async (_, state, expected) => {
    const r = repo(state);
    expect(await release(["0.8.0", "--dry-run"], r.deps)).toBe(0);
    expect(r.writes).toEqual([]);
    expect(r.questions).toEqual([]);
    expect(r.output).toContain(expected);
  });

  test("reports a failed precondition", async () => {
    const r = repo({ dirty: [" M README.md"] });
    expect(await release(["--dry-run", "0.8.0"], r.deps)).toBe(1);
    expect(r.writes).toEqual([]);
    expect(r.output).toContain("not clean");
  });
});
