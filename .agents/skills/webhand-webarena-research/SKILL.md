---
name: webhand-webarena-research
description: Run a ServiceNow/webarena-verified benchmark task through webhand, recording network.har and agent_response.json for deterministic offline evaluation. Research repository only; not part of the plugin. Use when asked to run a WebArena-Verified benchmark task, such as /webhand-webarena-research 108.
argument-hint: "TASK_ID [--out-dir DIR]"
allowed-tools: Read(skills/webhand/SKILL.md), Bash(node research/webarena.ts:*), AskUserQuestion
---

# webhand WebArena-Verified research run

Read `skills/webhand/SKILL.md` and follow it exactly, with these differences only:

- Run every command from the repository root as `node research/webarena.ts` in place of `webhand` (same arguments). Do not use `npx`.
- **Never open or read** the WebArena dataset JSON (`state/webarena/*.json`), `eval_result.json`, or `state/webarena/config.json`: reading expected answers invalidates the benchmark, and the config file may hold test-environment auto-login credentials.
- Start the task with `node research/webarena.ts start --task-id ID [--out-dir DIR] ...` (or inspect its public intent and start URL first with `node research/webarena.ts info --task-id ID`). The task supplies the GOAL, start URL, and HAR output path (`network.har`), so do not pass `--goal`, `--url`, or `--har`. Write `--step` and `--value` as `skills/webhand/SKILL.md` says.
- When `START_URLS:` lists more than one URL (a multi-site task), the first URL is already open; visit the others during the run when needed (`answer --url` or `replan --url`).
- Always end with `node research/webarena.ts finish`, supplying both webhand's `--status` and WebArena-Verified's structured `FinalAgentResponse` fields:
  - `--task-type RETRIEVE|MUTATE|NAVIGATE`
  - `--wa-status SUCCESS|ACTION_NOT_ALLOWED_ERROR|PERMISSION_DENIED_ERROR|NOT_FOUND_ERROR|DATA_VALIDATION_ERROR|UNKNOWN_ERROR`
  - `--retrieved-data '<JSON array>'` (required for `RETRIEVE` + `SUCCESS`, e.g. `'["Item A"]'` or `'[]'`; omit for `MUTATE` and `NAVIGATE`)
  - `--error-details '<concise reason>'` (omit when `--wa-status SUCCESS`; explain why when an error status is reported)
  - Add `--eval` when asked to score immediately with `uvx webarena-verified eval-tasks`.
- Report `status`, `task_type`, `wa_status`, `attempts`, `log`, `har`, `agent_response`, and (if evaluated) `webarena_verified_score`. Keep `webarena_verified_score` distinct from `tasks/`'s `verify()` — never call it `verify()`.
