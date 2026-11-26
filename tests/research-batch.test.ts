/** research/batch.ts with a fake herdr: no Claude, no Jev, no browser. */

import { mkdirSync, writeFileSync } from "node:fs";
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
  write(join(claudeDir, "settings.json"), { enabledPlugins: { "other@market": true } });
  write(join(claudeDir, "skills", "mine", "SKILL.md"), "");
  write(join(claudeDir, "skills", "synced", "account", "docs", "SKILL.md"), "");
  write(join(claudeDir, "skills", "synced", ".bucket-account_id"), "");
  write(join(claudeDir, "commands", "cmd.md"), "");
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

  it("records a failure before the launch and goes on to the next run", async () => {
    const out = tmpPath();
    const herdr = fake({ hotel_filter: true });
    write(join(herdr.deps.claudeDir, "settings.json"), "{");
    await batch(args(out, "--repeat", "2"), herdr.deps);
    const rows = readEvents(join(out, "results.jsonl"));
    expect(rows.map((row) => [row.n, row.verified, row.end_reason])).toEqual([
      [1, null, "launch_failed"],
      [2, null, "launch_failed"],
    ]);
    expect(rows[0].error).toContain("JSON");
    expect(herdr.calls.map((call) => call[1])).toEqual(["list"]);
  });

  it("lightens the session unless --full", async () => {
    const lean = fake({ hotel_filter: true });
    await batch(args(tmpPath()), lean.deps);
    const [command] = lean.commands();
    expect(command).toContain("'--tools' 'Bash,Read,AskUserQuestion,Skill'");
    expect(command).toContain("'--strict-mcp-config'");
    const settings = JSON.parse(/'--settings' '(.*)'$/.exec(command)?.[1] as string);
    expect(settings.disableBundledSkills).toBe(true);
    expect(settings.enabledPlugins).toEqual({ "other@market": false, "webhand@webhand": false });
    expect(Object.keys(settings.skillOverrides)).toEqual(["mine", "cmd", "docs", "anthropic-skills:docs"]);

    const full = fake({ hotel_filter: true });
    await batch(args(tmpPath(), "--full"), full.deps);
    for (const one of [command, full.commands()[0]]) {
      expect(one).toContain("'/webhand-research hotel_filter (session: new)'");
    }
    expect(full.commands()[0]).not.toContain("--tools");
    expect(full.commands()[0]).not.toContain("disableBundledSkills");
    expect(full.commands()[0]).toContain("'--strict-mcp-config'");
    expect(full.commands()[0]).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
  });

  it("refuses a missing model, an unknown task, and an --out that git would track", async () => {
    const { deps, calls } = fake({});
    await expect(batch(["--tasks", "hotel_filter", "--out", tmpPath()], deps)).rejects.toThrow("usage:");
    await expect(batch(["--tasks", "nope", "--model", "m", "--out", tmpPath()], deps)).rejects.toThrow("Unknown task");
    await expect(batch(args("docs/batch-out"), deps)).rejects.toThrow("ignored by git");
    expect(calls).toEqual([]);
  });
});
