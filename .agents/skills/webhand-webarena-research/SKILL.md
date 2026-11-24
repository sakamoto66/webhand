---
name: webhand-webarena-research
description: Run a ServiceNow/webarena-verified benchmark task through webhand, recording network.har and agent_response.json for deterministic offline evaluation. Research repository only; not part of the plugin. Use when asked to run a WebArena-Verified benchmark task, such as /webhand-webarena-research 108.
argument-hint: "[TASK_ID | --sites SITE] [--out-dir DIR]"
allowed-tools: Read(skills/webhand/SKILL.md), Bash(node research/webarena.ts:*), AskUserQuestion
---

# webhand WebArena-Verified research run

Read `skills/webhand/SKILL.md` and follow it exactly, with these differences only:

- Run every command from the repository root as `node research/webarena.ts` in place of `webhand` (same arguments). Do not use `npx`.
- **Never open or read** the WebArena dataset JSON (`state/webarena/*.json`), `eval_result.json`, or `state/webarena/config.json`: reading expected answers invalidates the benchmark, and the config file may hold test-environment auto-login credentials.
- **Discovering tasks & preflight checks**:
  - When no `TASK_ID` is given (e.g. a site or representative-template batch), list public task metadata with `node research/webarena.ts list [--sites SITE] [--one-per-template] [--pending --out-dir DIR] [--limit N]`. Inspect a single task with `node research/webarena.ts info --task-id ID`.
  - Before a batch run, verify dataset, host memory, site reachability, and auth mode without reading secrets via `node research/webarena.ts doctor [--sites SITE]`.
- **Resource & state discipline**:
  - Keep unused site containers stopped and run heavy sites (especially `gitlab`) sequentially (one session at a time) so headless Chrome starts reliably on memory-constrained hosts.
  - `MUTATE` tasks leave state in the container across runs. When strict isolation or repeatable comparison is needed, have the user reset the site container (`uvx webarena-verified env reset --site SITE`) before/after the round and record whether a reset was performed.
- Start the task with `node research/webarena.ts start --task-id ID [--out-dir DIR] ...`. The task supplies the GOAL, start URL, and HAR output path (`network.har`), so do not pass `--goal`, `--url`, or `--har`. Write `--step` and `--value` as `skills/webhand/SKILL.md` says.
- When `START_URLS:` lists more than one URL (a multi-site task), the first URL is already open; visit the others during the run when needed (`answer --url` or `replan --url`).
- Always end with `node research/webarena.ts finish`, supplying both webhand's `--status` and WebArena-Verified's structured `FinalAgentResponse` fields:
  - `--task-type RETRIEVE|MUTATE|NAVIGATE`: `NAVIGATE` when reaching/displaying the target page is the goal; `RETRIEVE` when returning answer value(s); `MUTATE` when creating, updating, or deleting state.
  - `--wa-status SUCCESS|ACTION_NOT_ALLOWED_ERROR|PERMISSION_DENIED_ERROR|NOT_FOUND_ERROR|DATA_VALIDATION_ERROR|UNKNOWN_ERROR`: use `SUCCESS` when fulfilled; when unfulfilled or `blocked`, pick the matching error code (`NOT_FOUND_ERROR` for missing target, `PERMISSION_DENIED_ERROR` / `ACTION_NOT_ALLOWED_ERROR` for forbidden actions, `DATA_VALIDATION_ERROR` for invalid input/constraints, `UNKNOWN_ERROR` for UI/environment blockers).
  - `--retrieved-data '<JSON array>'`: required for `RETRIEVE` + `SUCCESS` (always a JSON array even for one value, e.g. `'["Item A"]'` or `'[]'`, containing concise extracted values without prose wrappers); omit for `MUTATE` and `NAVIGATE`.
  - `--error-details '<concise reason>'`: omit when `--wa-status SUCCESS`; explain why when an error status is reported.
  - Add `--eval` when asked to score immediately with `uvx webarena-verified eval-tasks` (prints a compact single-line `WEBARENA_VERIFIED_SCORE` by default; add `--verbose` for full evaluator logs).
- After a batch run, aggregate offline with `node research/webarena.ts eval --output-dir DIR [--sites SITE]` and generate the complete summary table (including all failed/blocked/incomplete runs) with `node research/webarena.ts report --output-dir DIR`.
- Report `status`, `task_type`, `wa_status`, `attempts`, `log`, `har`, `agent_response`, and (if evaluated) `webarena_verified_score`. Keep `webarena_verified_score` distinct from `tasks/`'s `verify()` — never call it `verify()`.
