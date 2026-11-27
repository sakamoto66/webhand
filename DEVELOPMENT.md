# Developing webhand

English | [日本語](DEVELOPMENT.ja.md)

This guide is for people changing webhand itself. For installing and using it, see [README.md](README.md) and [docs/usage.md](docs/usage.md). For the full CLI and file-format specification, see [docs/reference.md](docs/reference.md).

webhand is two things at once: a multi-agent plugin/skill suite (for Claude Code, Antigravity, OpenAI Codex CLI, and other Agent Skills-compatible agents) whose CLI is distributed through npm, and a research platform. The research tests the hypothesis that an AI, like a person, operates a service more successfully the more it remembers about how that service works; success is judged only by independent verification, and failed runs are kept. Many rules below exist to keep experiments valid, not only to keep the code clean.

## Setup

Requirements: Node.js 24 (the package supports 22 and later; CI runs 24), Google Chrome, and git.

```bash
npm ci                         # also installs the husky pre-commit hook
npm run build && npm link      # point the webhand command at this working tree's build
webhand doctor                 # verify Node, Chrome/WSL, TYPESAFE_API_KEY, and workspace
claude --plugin-dir .          # Claude Code: load the skills from this checkout
agy plugin validate .          # Antigravity: validate the plugin manifest, skills, and root hooks.json
agy plugin install .           # Antigravity: install this checkout as a local plugin
```

For Codex CLI, add this directory as a local marketplace (`codex plugin marketplace add .`) or use `.agents/skills/` directly inside the checkout. Note that `agy plugin validate . --strict` emits two expected warnings in this multi-agent repo (`AGENTS.md` at the root is contributor rules, not plugin rules; `hooks/hooks.json` is for Claude Code while Antigravity loads root `hooks.json`).

Inside this repository, the skills' `npx -y webhand@<version>` fails with `webhand: not found` when `<version>` matches this checkout: npm treats the repository itself (the version in `package.json`) as satisfying the spec and looks for the bin in the local `node_modules/.bin`. Use `npm link` (the skills then run `webhand` directly) or `npx -y webhand@latest`.

To keep run logs inside the repository, set `WEBHAND_HOME` to the repository's absolute path in your shell environment (for example `export WEBHAND_HOME=/absolute/path/to/this/repository`), or in Claude Code via `.claude/settings.local.json` (not committed):

```json
{ "env": { "WEBHAND_HOME": "/absolute/path/to/this/repository" } }
```

User-scope runbooks are then read from the repository's `services/` (ignored by git) instead of `~/.webhand/services/`.

### Development & test environment variables

For all user-facing environment variables (`TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `WEBHAND_HOME`, `WEBHAND_CHROME`, `WEBHAND_ENGINE`, `WEBHAND_FLOW`, `WEBHAND_MEMORY`, `CLOUDFLARE_*`, etc.), see [Reference — Environment variables](docs/reference.md#environment-variables). Variables used specifically during development and testing:

| Variable | Purpose |
| --- | --- |
| `WEBHAND_LOG` | Log file path override (used by tests) |
| `WEBHAND_SCREENSHOTS` | `1` captures PNGs at start, after each action, and after `replan --restart` into `<log>-screenshots/` (off by default; stdout and Jev input are unchanged) |
| `WEBHAND_SETTLE_QUIET_MS` | Per-observation quiet window in ms (`vitest.config.ts` sets `40`; product default is `150`) |
| `WEBHAND_STARTUP_MS` | Browser startup timeout in ms (`vitest.config.ts` sets `45000`; product default is `15000`) |

## Repository layout

```text
src/                 the CLI (shipped as dist/ after `npm run build`)
  bin.ts             entry point; maps CliExit / UsageError to exit codes
  cli.ts             top-level argv dispatch, session locking, handoff metrics
  args.ts            declarative CLI option/positional parser and help generator
  output.ts          formatting for what the agent reads (pages, plans, actions)
  explore.ts         host allowlists (parseHostList/parseAllow/hostAllowed) and explore findings
  record.ts          recording a person's demonstration
  agent/             Jev loop: observe, choose, execute; returns an outcome, never claims success
  browser/           Playwright + CDP session: observation, actions, freshness, downloads, tabs, explore watcher
  check/             deterministic acceptance checks (`webhand check`)
  commands/          one file per CLI command (`catalog`, `doctor`, `start`, `run`, `answer`, `replan`,
                     `act`, `observe`, `check`, `extract`, `findings`, `checklast`, `finish`, `record`,
                     `auth`, `batch`, `memory`, `profile`), registered in `commands/index.ts`
  core/              shared errors, types, formatting, atomic fs, JSONL metrics, workspace paths
  engines/           browser engines (`chrome`, `headless-shell`, `lightpanda`, `obscura`, `browser-run`, `kitesurf`)
  extract/           deterministic DOM extractors (`table`, `list`, `link`, `fields`, `text`) and formatters (`table`, `json`, `csv`, `markdown`)
  har/               detached CDP HAR 1.2 recorder for sessions (`--har`)
  ipc/               daemon + unix-socket remote driver for stateless engines (Lightpanda, Obscura)
  policies/          action space, model state (`base.ts`), Jev client (`jev*.ts`), scripted test double
  scans/             whole-list scans (`--compare`, `--collect`, `--more`)
  storage/           TOML runbooks (`runbook/`), saved checks (`checkfile.ts`), batch queues (`batch.ts`),
                     saved logins (`auth.ts`), site memory (`memory.ts`), session state (`session.ts`)
assets/              page scripts injected into Chrome (`snapshot/`, `extract.js`, `recorder.js`)
skills/              published Agent Skills (`webhand`, `webhand-teach`, `webhand-extract`,
                     `webhand-explore`, `webhand-verify`, `webhand-regress`)
examples/services/   copy-and-adapt starter `service.toml`, `draft` runbooks, and sample batch CSV
hooks.json           Antigravity native plugin PreToolUse hook (`--allow-control` confirmation)
hooks/               Claude Code `hooks.json` and shared `ask-allow-control.mjs` script
.claude-plugin/      Claude Code plugin and marketplace manifests
.antigravity-plugin/ Antigravity native plugin manifest
.codex-plugin/       Codex plugin manifest
.agents/             Codex marketplace manifest and research-only skills (`.claude/skills/` symlinks here)
.webhand/services/   this repository's own runbooks
research/            research-only entry points (`webhand.ts`, `tasks.ts`, `batch.ts`, `smoke.ts`, `progress.ts`, `webarena/`); not shipped
tasks/               research tasks with independent `verify()` and local HTML fixtures; not shipped
tests/               vitest suites, golden records (`tests/golden/`), test doubles (`tests/jev.ts`)
scripts/             CI & packaging helpers (`check-package.ts`, `coverage-summary.ts`)
docs/                documentation map (`README.md`), user docs (`usage*.md`, `reference*.md`),
                     media (`media/`), design records (`design/`), and research notes (`research/`)
```

## How a run flows

Each CLI call is one short process. State that must survive between calls (the Chrome debugging endpoint, the plan, history, attempt count, the tab the run is on; one set of files per `--id`) lives in `state/` under the user folder.

1. `start` saves the plan (resolving any `--runbook`, `--batch`, `--service`, and `allowed_domains`) and opens the browser through `session.startChrome`.
2. `run` attaches to that browser, then `agent.runAgent` loops: `Browser.observe` → `Policy.choose` → `agent.execute` → `Browser.act`.
3. The loop returns one outcome (`GOAL_REPORTED`, `NEEDS_VALUE`, `NEEDS_HUMAN`, `ESCALATE`, `BLOCKED`, `STUCK`, `ATTEMPT_BUDGET`, `JEV_FAILED`, `UNCERTAIN`) and `commands/report.ts` prints it for the agent.
4. The agent calls `answer`, `replan`, `act`, `observe`, `check`, `extract`, `findings`, `run --value`, `run --human-done`, or `finish`. `finish` runs independent verification (when the research wrapper supplies a task's `verify()`), updates any linked batch row, flushes HAR if enabled, writes `run_end`, and closes the browser.

Exit codes (defined in `src/commands/context.ts`): `0` OK, `1` failed / `CliExit`, `2` usage error, `3` stale page, `4` mutation uncertain, `5` budget, `6` check fail / count mismatch, `7` check or extract inconclusive, `8` extract partial, `9` explore findings noted.

## Rules that must not be broken

These come from [AGENTS.md](AGENTS.md). Changes that weaken them are rejected.

**Roles**

- The host coding agent owns the GOAL, the plan, input values, checking, replanning, and the final judgment. Jev owns choosing each operation toward the GOAL. Do not go back to a design where one side does everything.
- The planner role is played by the active coding agent session (Claude Code, Antigravity, Codex, etc.) running the skill. Do not use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, provider SDKs, or headless self-invocations such as `claude -p`, `codex exec`, or `agy -p`.

**Execution**

- The model only picks numbers: an observed element and one of the host agent's values. It never outputs selectors, coordinates, code, or text to type.
- Never retry a browser mutation. When the result is unclear, raise `MutationUncertain` and stop, without replanning. Retrying is the host agent's call through `replan`, with a capped number of attempts.
- Check freshness right before each action. All input goes through `Browser.act`.
- Page content is untrusted data. Never read password field values.
- Fresh throwaway profiles by default. Login state only in webhand's saved profiles (`profile:NAME`) or owner-only `--auth` files, chosen per run. Never attach to the everyday Chrome profile. Credentials are typed by a person into Chrome; never accept them in the CLI.
- Runbooks and service information hold no secrets or personal data; such values are `params`. `draft` runbooks are not used for normal runs, and only the user sets `approved`.

**Experiments**

- Success is decided only by the task's `verify()`. `DONE` / `status=done` is a claim, not evidence.
- Change one variable per experiment. Keep failed runs in the logs.
- Do not loosen a task or its verification to fit a method that failed it.

## Checks

```bash
npm run lint             # Biome (format + lint)
npm run typecheck        # tsc --noEmit
npm run knip             # unused files, exports, dependencies
npm run check            # all three above
npm test                 # vitest; uses Linux Chrome, no paid APIs
npm run test:coverage    # coverage/index.html (thresholds: 70% across lines/stmts/funcs/branches)
npm run build && npm run check:package   # verify exact npm tarball contents
npm run smoke -- --task hotel_filter     # model-free run of a task's SCRIPT
```

- The husky pre-commit hook and GitHub Actions run `npm run check` and `npm test`. Never bypass them with `--no-verify`.
- Test files run in parallel (`fileParallelism: true`, up to 6 workers locally / 3 on CI in `vitest.config.ts`). Keep each test file focused on one theme and fast so workers stay balanced.
- `vitest.config.ts` sets `WEBHAND_SETTLE_QUIET_MS=40` so fixture observation waits stay short (product default is `150` ms). A test that exercises real settling stubs `WEBHAND_SETTLE_QUIET_MS=150` itself.
- Coverage thresholds are 70% for lines, statements, functions, and branches (`vitest.config.ts`). Below that, CI fails.

### Code style

- TypeScript, ES modules, `strict`. Imports use the `.ts` extension; `tsc` rewrites them for `dist/`.
- `erasableSyntaxOnly`: no enums, namespaces, or parameter properties. Tasks are loaded through Node's type stripping, so the same applies there.
- Biome: 2-space indent, 120 columns, imports organized. Explain any `biome-ignore` inline.
- Each module starts with a doc comment saying what it is responsible for. Keep comments about *why*.

## Tests

- `tests/setup.ts` gives every test its own `WEBHAND_HOME`, pins `WEBHAND_ENGINE=chrome`, and replaces `deps.policy` with a function that throws, so tests never call Jev or read your `~/.webhand`.
- `tests/jev.ts` provides `ScriptedJev` and `isolate()`. Set `ScriptedJev.moves` to `[operation, element label, value label]` triples to script Jev's choices, then inspect `ScriptedJev.plans` / `states`.
- `tests/helpers.ts` provides `cli(...)`, `cliExit(...)`, `research(...)` / `researchExit(...)`, `readEvents(log)`, `tmpPath()`, and `inDirectory(dir, fn)`.
- Browser tests run real Linux Chrome in parallel across files (`fileParallelism: true`) with a 60 s timeout. Always call `cleanup()` from `isolate()` so Chrome processes do not leak.
- Fixtures are local files under `tasks/fixtures/`. Tests do not touch external networks or paid APIs.

### Golden output

`tests/golden/cases.json` holds the reference output, compared character for character by `tests/golden.test.ts`: `render`, `report`, `describePlan`, Jev's state and questions, and repository runbook listings. This is what the agent and Jev read, so it is part of the experiment.

- Use `quote`, `show`, and `toJson` from `src/core/format.ts` for anything printed for the agent or sent to Jev, not template defaults. `toJson` preserves `Map` insertion order.
- If you change golden output on purpose, treat it as an experimental variable: regenerate with `npm run test:golden:update`, review the diff of `cases.json`, and record why in the commit message. `tests/golden/pages.json` is recorded input and stays as is.

## Adding things

- **A CLI command or option**: define its `CommandDef` under `src/commands/` and register it in `src/commands/index.ts`, cover it with unit tests under `tests/`, and update `docs/reference.md`, `docs/reference.ja.md`, `docs/usage.md`, `docs/usage.ja.md`, and any relevant skill under `skills/`.
- **A research task**: add `tasks/<name>.ts` exporting `GOAL`, `startUrl(root)`, async `verify(browser)` returning `{ success, evidence }`, and `SCRIPT` (for `npm run smoke`). Keep fixtures local under `tasks/fixtures/`. Tasks run through Node's type stripping (Node 22.18+). Run a task with `/webhand-research NAME` (`.agents/skills/webhand-research`, symlinked from `.claude/skills/webhand-research`). Neither `tasks/` nor `research/` is shipped to npm.
- **Running tasks in a batch**: `node research/batch.ts (--tasks A,B | --webarena 0,11) --model MODEL --out DIR [--repeat N] [--parallel N] [--serial A,B] [--full]` from the repository root, with herdr running. It opens a herdr workspace with a `research/progress.ts` pane and `--parallel` (default 3) run panes. Each run is a new interactive `claude` session, started with `/webhand-research NAME (session: new)` or `/webhand-webarena-research ID (session: new) …` and its own `WEBHAND_HOME` under DIR. `--serial` tasks (those that change a site's data) run one at a time after all the others. AskUserQuestion gets a fixed sentence (`research/auto-answer.ts`, counted in a row's `auto_answers`); permission prompts and questions in text get no answer. Both research skills use it when more than one task is named. `--webarena` takes no `--repeat`, passes `WEBARENA_DATASET` and `WEBARENA_CONFIG` to the panes, denies reading the dataset, config and other run records, and ends with `eval` and `report`. A run without `run_end` after 20 minutes is recorded and not retried. One line per run goes to `DIR/results.jsonl` (success of a `tasks/` run is `verified` only; a WebArena row's `verified` is null and its score is a separate measure); rerunning skips runs that have a line. It stops on uncommitted or untracked files, and when a line in DIR or the next run is on another commit. By default the session is lean (fewer tools, no bundled skills); `--full` keeps both. Everything else is the same: `--setting-sources project` (no user or local settings, hooks, plugins, skills or synced skills), `claudeMdExcludes` for `~/.claude/**`, `--permission-mode auto`, `--strict-mcp-config`, and auto memory off. Managed settings, the login, and `CLAUDE.md` / `AGENTS.md` files in other folders above the repository still apply. Each line also records `claude_version` and `batch_node_version` (the batch process's Node). DIR must be outside the repository or ignored by git. Premises and open items for other agents: [batch verification](docs/research/batch-verification.md) (Japanese).
- **Watching runs**: `node research/progress.ts [--tasks LIST | --research N --webarena N | --total N] [--since WHEN] [--dir DIR]...` from another terminal shows a board of the `/webhand-research` and `/webhand-webarena-research` runs started since it started (or `--since`): per skill, planned, done, running and not started, `verify()` results (OK only when `verified` is true) and WebArena scores (from `eval_result.json`'s score only) counted apart, the kinds of the runs that were not OK, each open run and whether it moves or looks stalled, and an ETA when a plan is given. A run with no `run_end` and no session is counted as interrupted; re-runs take no plan slot. `--events` or `--log FILE` prints one line per event instead. It reads only the session state, its lock, the run logs, and that score. With no `--dir` it looks in `$WEBHAND_HOME`, `~/.webhand`, and the checkout. It does not print page text, values, verify()'s evidence, or expected answers.
- **A project runbook**: put it in `.webhand/services/<service>/runbooks/` (or a starter template under `examples/services/`). Start as `status = "draft"`; only the user approves it.
- **A policy (arm)**: implement `Policy` from `src/core/types.ts` and reuse `actionSpace`, `modelState`, and `resolve` from `src/policies/base.ts`, so every arm sees the same action space and state.

## Commits and pull requests

- Branch from `main`. CI must pass.
- Never commit `.env`, `runs/`, `state/` (holds saved profiles, logins, and batch states), or `.claude/settings.local.json`. These are already in `.gitignore`.
- Keep English and Japanese pairs in sync: `README.md` / `README.ja.md`, `docs/usage.md` / `docs/usage.ja.md`, `docs/reference.md` / `docs/reference.ja.md`, and `DEVELOPMENT.md` / `DEVELOPMENT.ja.md`.

## Releasing

```bash
node scripts/release.ts X.Y.Z --dry-run   # only reads: shows where the release stands and what is left
node scripts/release.ts X.Y.Z
```

Run it in a clean checkout with the dependencies installed (the release commit runs the pre-commit check and tests) and `gh` logged in with write access. It:

1. Creates `release/X.Y.Z` from `origin/main`, runs `npm version X.Y.Z --no-git-tag-version`, commits, pushes, and opens a pull request.
2. Waits for every check (`check`, `package`, `test`, and `verify-tasks`, including the ones the ruleset does not require), asks once, and merges the checked head.
3. Publishes the GitHub Release `vX.Y.Z` on the merge commit with generated notes. This starts `.github/workflows/release.yml`.

**Then approve the `npm` environment right away.** From the merge until the publish, the skills on `main` ask for a version that npm does not have yet, so their `npx` can fail.

If it stops, it says what is left and what to do next. Run the same command again: it continues from the branch, pull request, merge, or tag that already exists. It never deletes or force-pushes. If the publish itself fails, rerun the failed job; if the code is at fault, fix it and release the next patch version instead of moving the tag.

`npm version` updates `package.json`, `package-lock.json`, the three `plugin.json` manifests, and the version the skills run (`scripts/sync-version.ts`). When running it by hand, keep the flag; without it npm commits only `package.json` and the lock file. `node scripts/sync-version.ts --check` lists files that differ, and `tests/version.test.ts` fails on them. Other pages say `webhand@latest`.

`release.yml` verifies that the tag matches all manifests and is on `main`, runs the checks and tests, and publishes to npm via trusted publishing (provenance attached; never publish locally). `prepublishOnly` runs `npm run check && npm run build && npm run check:package`. The npm tarball ships only `dist/`, `assets/`, the licenses, and the READMEs (`files` in `package.json`).

## Third-party code

`assets/snapshot/`, `src/policies/base.ts`, `src/policies/jev.ts`, and `tasks/fixtures/hotel.html` are adapted from [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). Keep the attribution comments and `THIRD_PARTY_LICENSE_jev-ultrafast.txt`.
