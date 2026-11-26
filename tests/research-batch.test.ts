/** research/batch.ts with a fake herdr: no Claude, no Jev, no browser. */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
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

/** A herdr whose panes finish at once when `verified` names the task, and otherwise stay in `status`. */
function fake(verified: Record<string, boolean>, status = "idle") {
  const claudeDir = tmpPath();
  const calls: string[][] = [];
  const output: string[] = [];
  let time = 0;
  const deps: Deps = {
    herdr(args) {
      calls.push(args);
      if (args[1] === "create") return JSON.stringify({ result: { root_pane: { pane_id: `p${calls.length}` } } });
      if (args[1] === "get") return JSON.stringify({ result: { pane: { agent_status: status } } });
      if (args[1] === "run") {
        const command = args[3];
        const home = /'WEBHAND_HOME=([^']+)'/.exec(command)?.[1] as string;
        const task = /'\/webhand-research (\S+) \(session: new\)'/.exec(command)?.[1] as string;
        const session = /'--session-id' '([^']+)'/.exec(command)?.[1] as string;
        write(join(claudeDir, "projects", "x", `${session}.jsonl`), message("a", 5), message("a", 7), message("b", 2));
        if (task in verified) {
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
    out: (text) => output.push(text),
  };
  const commands = () => calls.filter((args) => args[1] === "run").map((args) => args[3]);
  return { deps, calls, output, commands };
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
    expect(rows[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(rows[0]).toMatchObject({ claude_version: "9.9.9 (Claude Code)", batch_node_version: process.version });
    expect(herdr.calls.filter((call) => call[1] === "close").map((call) => call[2])).toEqual(["p2", "p6"]);
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

  it.each([
    ["blocked", "needs_input", true],
    ["working", "timeout", false],
  ])("records a pane left %s as %s", async (status, reason, blocked) => {
    const out = tmpPath();
    const herdr = fake({}, status);
    await batch(args(out), herdr.deps);
    expect(readEvents(join(out, "results.jsonl"))[0]).toMatchObject({ verified: null, end_reason: reason, blocked });
    expect(herdr.calls.at(-1)).toEqual(["pane", "close", "p2"]);
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
        if (args[1] === "create") throw new Error("no tab");
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
    expect(herdr.calls.map((call) => call[1])).toEqual(["list", "create", "create"]);
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
    };
    expect(lighter).toEqual({ ...shared, disableBundledSkills: true });
    expect(full.commands()[0]).not.toContain("--tools");
    const { env: _, ...whole } = settings(full.commands()[0]);
    expect(whole).toEqual(shared);
  });

  it("refuses a missing model, an unknown task, and an --out that git would track", async () => {
    const { deps, calls } = fake({});
    await expect(batch(["--tasks", "hotel_filter", "--out", tmpPath()], deps)).rejects.toThrow("usage:");
    await expect(batch(["--tasks", "nope", "--model", "m", "--out", tmpPath()], deps)).rejects.toThrow("Unknown task");
    await expect(batch(args("docs/batch-out"), deps)).rejects.toThrow("ignored by git");
    expect(calls).toEqual([]);
  });
});
