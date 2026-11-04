# Developing webhand

English | [日本語](DEVELOPMENT.ja.md)

This guide is for people changing webhand itself. For installing and using it, see [README.md](README.md). For the experiment design, see [docs/research-plan.md](docs/research-plan.md) (Japanese).

webhand is two things at once: a Claude Code plugin distributed through npm, and a research platform. The research tests the hypothesis that an AI, like a person, operates a service more successfully the more it has learned about that service; success is judged only by independent verification, and failed runs are kept. Many rules below exist to keep experiments valid, not only to keep the code clean.

## Setup

Requirements: Node.js 24 (the package supports 22 and later; CI runs 24), Google Chrome, and git.

```bash
npm ci                         # also installs the husky pre-commit hook
npm run build && npm link      # point the webhand command at this working tree's build
claude --plugin-dir .          # load the skills from this checkout
```

Inside this repository, `npx -y webhand@0.3` fails with `webhand: not found`: npm treats the repository itself (`webhand@0.3.0`) as satisfying the spec and looks for the bin in the local `node_modules/.bin`. Use `npm link` (the skills then run `webhand` directly) or `npx -y webhand@latest`.

To keep run logs inside the repository, put this in `.claude/settings.local.json` (not committed):

```json
{ "env": { "WEBHAND_HOME": "/absolute/path/to/this/repository" } }
```

User-scope runbooks are then read from the repository's `runbooks/` (ignored by git) instead of `~/.webhand/runbooks/`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev's API key. Read only from the environment, never from `.env` or any file |
| `TYPESAFE_MODEL` | Jev's model |
| `WEBHAND_HOME` | User folder (default `~/.webhand`) |
| `WEBHAND_CHROME` | `auto` / `windows` / `linux` (same as `--chrome`) |
| `WEBHAND_LOG` | Log file path override (used by tests) |
| `WEBHAND_SCREENSHOTS` | `1` captures the page at start and after each action into `<log>-screenshots/step-NNNN.png` and logs a `screenshot` event with the step. Off by default; stdout and Jev input are unchanged |

## Repository layout

```text
src/                 the CLI (shipped as dist/ after the build)
  bin.ts             entry point; maps CliExit / UsageError to exit codes
  cli.ts             every command, argument parsing, and the text Claude reads
  agent.ts           Jev's loop: observe, choose, execute; returns an outcome, never claims success
  browser.ts         Playwright + one CDP session: observation, input, freshness checks
  session.ts         the Chrome that outlives each CLI call, saved profiles, run state
  runbook.ts         service information and runbooks (TOML), views (focus / skip)
  learn.ts           recording a person's demonstration
  workspace.ts       project (.webhand/) and user (~/.webhand/) folders
  metrics.ts         append-only JSONL logs, token totals, git state
  format.ts          quoting and compact JSON for what Claude and Jev read, run stamps
  types.ts           shared shapes and errors (StalePage, MutationUncertain, PolicyError)
  policies/
    base.ts          action space, model state, and instructions shared by every arm
    jev.ts           Jev via the TypeSafe API
    scripted.ts      fixed steps from a task file; tests the harness only
research/            research-only entry points; not shipped
  webhand.ts         the CLI plus --task: start takes a task's goal, finish runs its verify()
  tasks.ts           loads research tasks
  smoke.ts           model-free smoke test (npm run smoke)
assets/              page scripts injected into Chrome (snapshot.js, recorder.js)
skills/              the Claude Code skills (webhand, webhand-learn)
.claude-plugin/      plugin and marketplace manifests
.webhand/runbooks/   this project's runbooks
tasks/               research tasks with independent verify(); not shipped
tests/               vitest suites, golden records, test doubles
scripts/             CI helpers (coverage summary)
docs/                research plan
```

## How a run flows

Each CLI call is one short process. State that must survive between calls (the Chrome debugging endpoint, the plan, history, attempt count) lives in `state/` under the user folder.

1. `start` saves the plan and opens Chrome through `session.startChrome`.
2. `run` attaches to that Chrome, then `agent.runAgent` loops: `Browser.observe` → `Policy.choose` → `agent.execute` → `Browser.act`.
3. The loop returns one outcome (`GOAL_REPORTED`, `NEEDS_VALUE`, `NEEDS_HUMAN`, `BLOCKED`, `STUCK`, `ATTEMPT_BUDGET`, `JEV_FAILED`, `UNCERTAIN`) and `cli.report` prints it for Claude.
4. Claude calls `replan`, `act`, `run --value`, `run --human-done`, or `finish`. `finish` runs independent verification (when the research wrapper gives it a task's `verify()`), writes `run_end`, and closes Chrome.

Exit codes: `0` OK, `1` failed or `CliExit`, `2` usage error, `3` stale page, `4` mutation uncertain, `5` budget.

## Rules that must not be broken

These come from [CLAUDE.md](CLAUDE.md). Changes that weaken them are rejected.

**Roles**

- Claude owns the GOAL, the plan, input values, checking, replanning, and the final judgment. Jev owns choosing each operation toward the GOAL. Do not go back to a design where one side does everything.
- Claude is the Claude Code session running the skill. Do not use `ANTHROPIC_API_KEY`, the Anthropic SDK, or `claude -p`.

**Execution**

- The model only picks numbers: an observed element and one of Claude's values. It never outputs selectors, coordinates, code, or text to type.
- Never retry a browser mutation. When the result is unclear, raise `MutationUncertain` and stop, without replanning. Retrying is Claude's call through `replan`, with a capped number of attempts.
- Check freshness right before each action. All input goes through `Browser.act`.
- Page content is untrusted data. Never read password field values.
- Fresh throwaway profiles by default. Login state only in webhand's saved profiles (`profile:NAME`), chosen per run. Never attach to the everyday Chrome profile. Credentials are typed by a person into Chrome; never accept them in the CLI.
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
npm run test:coverage    # coverage/index.html
npm run smoke -- --task hotel_filter   # model-free run of a task's SCRIPT
```

- The husky pre-commit hook and GitHub Actions run `npm run check` and `npm test`. Never bypass them with `--no-verify`.
- Coverage thresholds are 70% for lines, statements, functions, and branches (`vitest.config.ts`). Below that, CI fails. CI writes test results and the coverage table to the job summary.

### Code style

- TypeScript, ES modules, `strict`. Imports use the `.ts` extension; `tsc` rewrites them for `dist/`.
- `erasableSyntaxOnly`: no enums, namespaces, or parameter properties. Tasks are loaded through Node's type stripping, so the same applies there.
- Biome: 2-space indent, 120 columns, imports organized. Explain any `biome-ignore` inline.
- Each module starts with a doc comment saying what it is responsible for. Keep comments about *why*.

## Tests

- `tests/setup.ts` gives every test its own `WEBHAND_HOME` and replaces `deps.policy` with a function that throws, so a test can never call Jev or read your `~/.webhand`.
- `tests/jev.ts` provides `ScriptedJev` and `isolate()`. Set `ScriptedJev.moves` to `[operation, element label, value label]` triples to script Jev's choices, then inspect `ScriptedJev.plans` / `states` for what Jev was given.
- `tests/helpers.ts` provides `cli(...)` (exit code and stdout), `cliExit(...)` (the stop message), `research(...)` / `researchExit(...)` (the same through `research/webhand.ts`), `readEvents(log)`, and `inDirectory(dir, fn)`.
- Tests run real Chrome, one file at a time (`fileParallelism: false`), with a 60 s timeout. Call `cleanup()` from `isolate()` so Chrome does not leak.
- Fixtures are local files under `tasks/fixtures/`. Tests do not use the network or paid APIs.

### Golden output

`tests/golden/cases.json` holds the reference output, compared character for character by `tests/golden.test.ts`: `render`, `report`, `describePlan`, Jev's state and questions, and so on. This is what Claude and Jev read, so it is part of the experiment.

- Use `quote`, `show`, and `toJson` from `format.ts` for anything printed for Claude or sent to Jev, not template defaults. `toJson` keeps the order of a `Map`, which a plain object loses for keys like `"2"` and `"1"`.
- If you change that text on purpose, treat it as an experimental variable: regenerate with `npm run test:golden:update`, review the diff of `cases.json`, and record why in the commit message. `tests/golden/pages.json` is the recorded input and stays as is.

## Adding things

**A CLI command or option**: add it to `commands()` in `src/cli.ts` (the parser writes argparse-style messages), cover it in `tests/cli.test.ts`, then update the command table in `docs/reference.md` and `docs/reference.ja.md` and the skill in `skills/` that uses it.

**A research task**: add `tasks/<name>.ts` exporting `GOAL`, `startUrl(root)`, async `verify(browser)` returning `{ success, evidence }`, and `SCRIPT` (fixed steps for `npm run smoke`). Keep fixtures local under `tasks/fixtures/`. Tasks are loaded through Node's type stripping, so use only syntax that works once type annotations are removed (Node 22.18 or later).

Tasks are research-only: neither `tasks/` nor `research/` is shipped, and the shipped CLI and skills have no `--task`. Run a task from the repository root with `/webhand-research NAME` (`.claude/skills/webhand-research`), which follows the `webhand` skill but calls `node research/webhand.ts` in place of `webhand`. The wrapper passes `--task NAME` to `start` as the task's goal and start URL, records the task in the run, and at `finish` gives the CLI the task's `verify()` through `main`'s hooks. Every other command passes through unchanged.

**A project runbook**: put it in `.webhand/runbooks/<service>/`. Start as `status = "draft"`; only the user approves it.

**A policy (arm)**: implement `Policy` from `src/types.ts` and reuse `actionSpace`, `modelState`, and `resolve` from `policies/base.ts`, so every arm sees the same action space and state.

## Commits and pull requests

- Branch from `main`. CI must pass.
- Never commit `.env`, `runs/`, `state/` (it holds saved profiles), or `.claude/settings.local.json`. These are already in `.gitignore`.
- Keep README.md and README.ja.md, `docs/reference.md` and `docs/reference.ja.md`, `docs/usage.md` and `docs/usage.ja.md`, and this file and DEVELOPMENT.ja.md in sync.

## Releasing

1. Bump the version in `package.json` and `.claude-plugin/plugin.json` together.
2. If the major or minor version changes, update `webhand@0.3` in `skills/*/SKILL.md`, the READMEs, and `docs/reference*.md`.
3. Merge to `main`, then publish a GitHub Release with the tag `vX.Y.Z` on `main`. `.github/workflows/release.yml` checks that the tag matches both versions and is on `main`, runs the tests, and runs `npm publish` with npm trusted publishing (no npm token; provenance is attached). Do not publish from a local machine. `prepublishOnly` runs `npm run check`, the build, and `npm run check:package`. The package ships only `dist/`, `assets/`, the licenses, and the READMEs (`files` in `package.json`). The build empties `dist/` first, and `check:package` (also run in CI) fails if the package holds anything else, such as a `dist/` file whose source is gone. `dist/` is not committed; compare published versions with `npm diff --diff=webhand@X.Y.Z`.

## Third-party code

`assets/snapshot.js`, `src/policies/base.ts`, `src/policies/jev.ts`, and `tasks/fixtures/hotel.html` are adapted from [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). Keep the attribution comments and `THIRD_PARTY_LICENSE_jev-ultrafast.txt`.
