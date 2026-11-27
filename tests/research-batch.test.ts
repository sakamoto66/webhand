/** research/batch.ts with a fake herdr: no Claude, no Jev, no browser. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reply } from "../research/auto-answer.ts";
import { batch, type Deps } from "../research/batch.ts";
import { readEvents, tmpPath } from "./helpers.ts";

const write = (file: string, ...lines: unknown[]) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
};

const message = (id: string, output: number) => ({
  type: "assistant",
  message: { id, usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 10 } },
});

const HEAD = "a".repeat(40);

/** A herdr whose panes finish at once when `verified` names the task, and otherwise stay in `status`. */
function fake(verified: Record<string, boolean>, status = "idle") {
  const claudeDir = tmpPath();
  const calls: string[][] = [];
  const output: string[] = [];
  const scored: string[][] = [];
  let time = 0;
  let panes = 0;
  const deps: Deps = {
    herdr(args) {
      calls.push(args);
      if (args[1] === "create") return JSON.stringify({ result: { root_pane: { pane_id: `p${++panes}` } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: `p${++panes}` } } });
      if (args[1] === "get") return JSON.stringify({ result: { pane: { agent_status: status } } });
      if (args[1] === "run") {
        const command = args[3];
        if (command.includes("research/progress.ts")) return "";
        const id = /'\/webhand-webarena-research (\d+) /.exec(command)?.[1];
        const out = /Pass --out-dir (\S+) to start/.exec(command)?.[1];
        const home = /'WEBHAND_HOME=([^']+)'/.exec(command)?.[1] as string;
        const task = /'\/webhand-research (\S+) \(session: new\)'/.exec(command)?.[1] as string;
        const session = /'--session-id' '([^']+)'/.exec(command)?.[1] as string;
        write(join(claudeDir, "projects", "x", `${session}.jsonl`), message("a", 5), message("a", 7), message("b", 2));
        if (id && out) {
          const log = join(out, id, "webhand.jsonl");
          const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
          write(log, ...lines, { type: "run_end", status: "done", attempts: 1 });
        } else if (task in verified) {
          const end = { type: "run_end", verified: verified[task], attempts: 2 };
          write(join(home, "runs", "now", `${task}.jsonl`), { type: "run_start" }, end, '{"type":');
        }
      }
      return "";
    },
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
    claudeDir,
    claudeVersion: () => "9.9.9 (Claude Code)",
    webarenaIds: () => [0, 11, 423],
    webarena(args) {
      scored.push(args);
      return `${args[0]} done`;
    },
    // A clean tree on HEAD, whatever the checkout running the tests holds; only the ignore rules are real.
    git(...args) {
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return HEAD;
      return execFileSync("git", args, { encoding: "utf8", stdio: "pipe" });
    },
    out: (text) => output.push(text),
  };
  const runs = () => calls.filter((args) => args[1] === "run").map((args) => args[3]);
  const commands = () => runs().filter((command) => command.includes("'claude'"));
  const board = () => runs().filter((command) => command.includes("research/progress.ts"));
  return { deps, calls, output, commands, board, scored };
}

const args = (out: string, ...more: string[]) => ["--tasks", "hotel_filter", "--model", "m", "--out", out, ...more];

describe("research/batch.ts", () => {
  it("records one line per run, counts each message once, and closes only its own pane", async () => {
    const out = tmpPath();
    const herdr = fake({ hotel_filter: true });
    await batch(args(out, "--repeat", "2"), herdr.deps);
    const rows = readEvents(join(out, "results.jsonl"));
    expect(rows.map((row) => [row.n, row.verified, row.attempts, row.end_reason, row.profile])).toEqual([
      [1, true, 2, "run_end", "lean"],
      [2, true, 2, "run_end", "lean"],
    ]);
    expect(rows[0].tokens).toMatchObject({ input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 20 });
    expect(rows[0].commit).toBe(HEAD);
    expect(rows[0]).toMatchObject({ claude_version: "9.9.9 (Claude Code)", batch_node_version: process.version });
    // p1 is the board; each used pane is closed after its replacement opens, and the last shells are closed.
    expect(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2])).toEqual(["p2", "p3", "p4", "p5"]);
    expect(herdr.output).toContain("VERIFIED 2/2 (100%)");
    expect(herdr.output.join("\n")).toContain("output_tokens=18");
  });

  it("resumes from the runs that have no line, without retrying failures", async () => {
    const out = tmpPath();
    await batch(args(out), fake({ hotel_filter: false }).deps);
    const herdr = fake({ hotel_filter: true });
    await batch(args(out, "--repeat", "2"), herdr.deps);
    expect(herdr.commands()).toHaveLength(1);
    expect(readEvents(join(out, "results.jsonl")).map((row) => row.verified)).toEqual([false, true]);
    expect(herdr.output).toContain("VERIFIED 1/2 (50%)");
  });

  /** The fake deps with another answer to one git command. */
  const withGit = (deps: Deps, command: string, answer: () => string): Deps => ({
    ...deps,
    git: (...args) => (args[0] === command ? answer() : deps.git(...args)),
  });

  it("stops on an --out holding another commit's run, without reusing or adding a line", async () => {
    const out = tmpPath();
    await batch(args(out), fake({ hotel_filter: true }).deps);
    const herdr = fake({ hotel_filter: true });
    const deps = withGit(herdr.deps, "rev-parse", () => "b".repeat(40));
    await expect(batch(args(out, "--repeat", "2"), deps)).rejects.toThrow("Use a new --out");
    await expect(batch(args(out), deps)).rejects.toThrow(HEAD);
    expect(herdr.calls).toEqual([]);
    expect(readEvents(join(out, "results.jsonl"))).toHaveLength(1);
  });

  it("refuses to start with uncommitted or untracked files", async () => {
    const herdr = fake({ hotel_filter: true });
    const deps = withGit(herdr.deps, "status", () => "?? tasks/new.ts");
    await expect(batch(args(tmpPath()), deps)).rejects.toThrow("?? tasks/new.ts");
    expect(herdr.calls).toEqual([]);
  });

  it.each([
    ["rev-parse", "b".repeat(40), "HEAD moved"],
    ["status", " M research/batch.ts", "research/batch.ts"],
  ])("stops before the next run when git %s changes during the batch", async (command, changed, message) => {
    const out = tmpPath();
    const herdr = fake({ hotel_filter: true });
    const before = herdr.deps.git(command);
    const deps = withGit(herdr.deps, command, () => (herdr.commands().length ? changed : before));
    await expect(batch(args(out, "--repeat", "2"), deps)).rejects.toThrow(message);
    expect(herdr.commands()).toHaveLength(1);
    expect(readEvents(join(out, "results.jsonl"))).toHaveLength(1);
  });

  it.each([
    ["blocked", "needs_input", true],
    ["working", "timeout", false],
  ])("records a pane left %s as %s", async (status, reason, blocked) => {
    const out = tmpPath();
    const herdr = fake({}, status);
    await batch(args(out), herdr.deps);
    expect(readEvents(join(out, "results.jsonl"))[0]).toMatchObject({ verified: null, end_reason: reason, blocked });
    expect(herdr.calls).toContainEqual(["pane", "close", "p2"]);
  });

  it("records a pane that blocks while the report is awaited", async () => {
    const out = tmpPath();
    const herdr = fake({ hotel_filter: true });
    const states = ["working", "blocked"];
    const deps: Deps = {
      ...herdr.deps,
      herdr(args) {
        const result = herdr.deps.herdr(args);
        if (args[1] !== "get") return result;
        return JSON.stringify({ result: { pane: { agent_status: states.shift() } } });
      },
    };
    await batch(args(out), deps);
    expect(readEvents(join(out, "results.jsonl"))[0]).toMatchObject({ end_reason: "run_end", blocked: true });
    expect(states).toEqual([]);
  });

  it("records a failure before the launch and goes on to the next run", async () => {
    const out = tmpPath();
    const herdr = fake({ hotel_filter: true });
    const deps: Deps = {
      ...herdr.deps,
      herdr(args) {
        const result = herdr.deps.herdr(args);
        if (args[1] === "run" && args[3].includes("'claude'")) throw new Error("no tab");
        return result;
      },
      claudeVersion() {
        throw new Error("no claude");
      },
    };
    await batch(args(out, "--repeat", "2"), deps);
    const rows = readEvents(join(out, "results.jsonl"));
    expect(rows.map((row) => [row.n, row.verified, row.end_reason])).toEqual([
      [1, null, "launch_failed"],
      [2, null, "launch_failed"],
    ]);
    expect(rows[0]).toMatchObject({ error: "no tab", claude_version: null });
  });

  it("lightens the session unless --full", async () => {
    const lean = fake({ hotel_filter: true });
    await batch(args(tmpPath()), lean.deps);
    const [command] = lean.commands();
    expect(command).toContain("'--tools' 'Bash,Read,AskUserQuestion,Skill'");
    expect(command).toContain("'--strict-mcp-config'");
    const full = fake({ hotel_filter: true });
    await batch(args(tmpPath(), "--full"), full.deps);
    for (const one of [command, full.commands()[0]]) {
      expect(one).toContain("'/webhand-research hotel_filter (session: new)'");
      expect(one).toContain("'--strict-mcp-config' '--setting-sources' 'project' '--permission-mode' 'auto'");
      expect(one).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
    }
    const settings = (one: string) => JSON.parse(/'--settings' '(.*)'$/.exec(one)?.[1] as string);
    const { env, ...lighter } = settings(command);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    const shared = {
      claudeMdExcludes: [join(homedir(), ".claude", "**")],
      skillOverrides: { "auto-mode-setup": "off" },
      hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [expect.objectContaining({ type: "command" })] }] },
    };
    expect(lighter).toEqual({ ...shared, disableBundledSkills: true });
    expect(full.commands()[0]).not.toContain("--tools");
    const { env: _, ...whole } = settings(full.commands()[0]);
    expect(whole).toEqual(shared);
  });

  it("runs --parallel at a time, then the --serial ones one by one", async () => {
    const out = tmpPath();
    const herdr = fake({});
    const events: string[] = [];
    const deps: Deps = {
      ...herdr.deps,
      out(text) {
        events.push(text.trim().split(" ").slice(0, 2).join(" "));
      },
    };
    await batch(["--webarena", "423,0,11", "--serial", "423", "--model", "m", "--out", out, "--parallel", "2"], deps);
    expect(events.slice(0, 6)).toEqual([
      "RUN webarena_0",
      "RUN webarena_11",
      "webarena_0 #1",
      "webarena_11 #1",
      "RUN webarena_423",
      "webarena_423 #1",
    ]);
    const rows = readEvents(join(out, "results.jsonl"));
    expect(rows.map((row) => [row.task, row.status, row.serial, row.verified])).toEqual([
      ["webarena_0", "done", false, null],
      ["webarena_11", "done", false, null],
      ["webarena_423", "done", true, null],
    ]);
    expect(herdr.board()).toHaveLength(1);
    expect(herdr.board()[0]).toContain("'--tasks' 'webarena_0,webarena_11,webarena_423'");
    expect(herdr.scored.map((args) => args[0])).toEqual(["eval", "report"]);
    expect(events).toContain("RUNS 3/3");
  });

  it("keeps a WebArena session from the answer files and answers its questions", async () => {
    const out = tmpPath();
    const herdr = fake({});
    await batch(["--webarena", "0", "--model", "m", "--out", out], herdr.deps);
    const [command] = herdr.commands();
    expect(command).toContain(`'/webhand-webarena-research 0 (session: new) Pass --out-dir ${out} to start.`);
    const settings = JSON.parse(/'--settings' '(.*)'$/.exec(command)?.[1] as string);
    expect(settings.permissions.deny).toContain(`Read(/${out}/**)`);
    expect(settings.permissions.deny).toContain("Bash(*eval_result.json*)");
    expect(settings.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
  });

  it("does not take an earlier run's end for a WebArena task run again", async () => {
    const out = tmpPath();
    write(join(out, "0", "webhand.jsonl"), { type: "run_end", status: "error", attempts: 3 });
    await batch(["--webarena", "0", "--model", "m", "--out", out], fake({}).deps);
    expect(readEvents(join(out, "results.jsonl"))[0]).toMatchObject({ status: "done", attempts: 1 });
  });

  it.each([
    [["--webarena", "7"], "Unknown WebArena task ID"],
    [["--webarena", "0", "--repeat", "2"], "--repeat is not for --webarena"],
    [["--webarena", "0,0"], "twice"],
    [["--webarena", "0", "--serial", "11"], "not run"],
    [["--webarena", "0", "--tasks", "hotel_filter"], "usage:"],
    [["--webarena", "0", "--parallel", "0"], "usage:"],
  ])("refuses %j", async (more, message) => {
    const { deps, calls } = fake({});
    await expect(batch([...more, "--model", "m", "--out", tmpPath()], deps)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("answers a question with a fixed sentence, and one about signing in with another", () => {
    const answers = (question: string) =>
      reply({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question }] } })?.hookSpecificOutput
        .updatedInput.answers;
    expect(answers("Which one?")).toEqual({ "Which one?": "お答えできません。手元の情報だけで進めてください。" });
    expect(answers("Please sign in")).toEqual({ "Please sign in": "対応できません。手元の情報だけで進めてください。" });
    expect(reply({ tool_name: "Bash" })).toBeNull();
  });

  it("opens one tab, in the workspace it was started from", async () => {
    vi.stubEnv("HERDR_WORKSPACE_ID", "w9");
    const herdr = fake({ hotel_filter: true });
    await batch(args(tmpPath()), herdr.deps);
    const created = herdr.calls.filter((call) => call[1] === "create");
    expect(created.map((call) => call.slice(0, 4))).toEqual([["tab", "create", "--workspace", "w9"]]);
    vi.unstubAllEnvs();
  });

  it("refuses a missing model, an unknown task, and an --out that git would track", async () => {
    const { deps, calls } = fake({});
    await expect(batch(["--tasks", "hotel_filter", "--out", tmpPath()], deps)).rejects.toThrow("usage:");
    await expect(batch(["--tasks", "nope", "--model", "m", "--out", tmpPath()], deps)).rejects.toThrow("Unknown task");
    await expect(batch(args("docs/batch-out"), deps)).rejects.toThrow("ignored by git");
    expect(calls).toEqual([]);
  });
});
